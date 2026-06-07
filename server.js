const express = require("express");
const app = express();
app.use(express.json({ limit: "10mb" }));

const TTS_BASE_URL = process.env.TTS_BASE_URL || "http://localhost:8880";
const PORT = process.env.PORT || 8881;

let latexToSpeech;

// ── Startup ──────────────────────────────────────────────────────────

async function init() {
  latexToSpeech = require("latex-to-speech");
  try {
    const test = await latexToSpeech(["\\frac{a}{b}"], { domain: "clearspeak" });
    console.log(`SRE warmup ok — \\frac{a}{b} → "${test[0]}"`);
  } catch (e) {
    console.error("SRE warmup failed:", e.message);
  }
}

// ── LaTeX → spoken text ──────────────────────────────────────────────

async function convertLatex(expr) {
  try {
    const result = await latexToSpeech([expr], { domain: "clearspeak" });
    return result[0] || expr;
  } catch (e) {
    console.error(`SRE failed on "${expr.slice(0, 60)}":`, e.message);
    return expr;
  }
}

// Replace regex matches with async replacements (processed in reverse
// to keep string indices valid across substitutions)
async function asyncReplace(text, regex, fn) {
  const hits = [];
  let m;
  while ((m = regex.exec(text)) !== null) {
    hits.push({ idx: m.index, len: m[0].length, match: m });
  }
  for (const h of hits.reverse()) {
    const rep = await fn(h.match);
    text = text.slice(0, h.idx) + rep + text.slice(h.idx + h.len);
  }
  return text;
}

// ── Full text cleanup pipeline ───────────────────────────────────────

async function cleanForTTS(text) {
  // 1 — Strip fenced code blocks (``` … ```)
  text = text.replace(/```[\s\S]*?```/g, "");

  // 2 — Display math: $$…$$ then \[…\]
  text = await asyncReplace(text, /\$\$([\s\S]*?)\$\$/g, async (m) => {
    return " " + (await convertLatex(m[1].trim())) + ". ";
  });
  text = await asyncReplace(text, /\\\[([\s\S]*?)\\\]/g, async (m) => {
    return " " + (await convertLatex(m[1].trim())) + ". ";
  });

  // 3 — Inline math: $…$ then \(…\)   (safe now that $$ is gone)
  text = await asyncReplace(text, /\$([^$]+?)\$/g, async (m) => {
    return await convertLatex(m[1].trim());
  });
  text = await asyncReplace(text, /\\\(([\s\S]*?)\\\)/g, async (m) => {
    return await convertLatex(m[1].trim());
  });

  // 4 — Strip markdown formatting
  text = text.replace(/^#{1,6}\s+/gm, "");              // headers
  text = text.replace(/\*\*\*(.*?)\*\*\*/g, "$1");      // bold italic
  text = text.replace(/\*\*(.*?)\*\*/g, "$1");           // bold
  text = text.replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g, "$1"); // italic
  text = text.replace(/~~(.*?)~~/g, "$1");               // strikethrough
  text = text.replace(/`([^`]*)`/g, "$1");               // inline code
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");  // links → keep label
  text = text.replace(/^[\s]*[-*+]\s+/gm, "");          // unordered list bullets
  text = text.replace(/^[\s]*\d+\.\s+/gm, "");          // ordered list numbers
  text = text.replace(/^>\s?/gm, "");                    // blockquotes
  text = text.replace(/^-{3,}$/gm, "");                 // horizontal rules
  text = text.replace(/^\|.*\|$/gm, (line) => {         // markdown tables
    if (/^[\s|:-]+$/.test(line)) return "";               //   skip separator rows
    return line.replace(/\|/g, ", ").replace(/^,\s*|,\s*$/g, "");
  });

  // 5 — Collapse whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]+/g, " ");
  text = text.trim();

  return text;
}

// ── Routes ───────────────────────────────────────────────────────────

// Health check (own)
app.get("/health", (_req, res) => res.json({ status: "ok", proxy: true }));

// TTS endpoint — intercept, clean, forward
app.post("/v1/audio/speech", async (req, res) => {
  try {
    const body = { ...req.body };

    if (body.input) {
      const before = body.input;
      body.input = await cleanForTTS(body.input);
      const preview = (s) => (s.length > 100 ? s.slice(0, 100) + "…" : s);
      console.log(`IN:  ${preview(before)}`);
      console.log(`OUT: ${preview(body.input)}`);
    }

    const upstream = await fetch(`${TTS_BASE_URL}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!["transfer-encoding", "connection"].includes(k)) res.setHeader(k, v);
    });

    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.error("Speech proxy error:", err.message);
    res.status(502).json({ error: "TTS backend unreachable", detail: err.message });
  }
});

// Everything else → transparent pass-through to Kokoro
app.all("/*", async (req, res) => {
  try {
    const opts = { method: req.method, headers: {} };
    if (!["GET", "HEAD"].includes(req.method)) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(req.body);
    }
    const upstream = await fetch(`${TTS_BASE_URL}${req.path}`, opts);

    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!["transfer-encoding", "connection"].includes(k)) res.setHeader(k, v);
    });
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.error("Pass-through error:", err.message);
    res.status(502).json({ error: "TTS backend unreachable" });
  }
});

// ── Start ────────────────────────────────────────────────────────────

init().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`TTS LaTeX proxy :${PORT} → ${TTS_BASE_URL}`);
  });
});
