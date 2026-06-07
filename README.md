# tts-latex-proxy

A lightweight proxy that converts LaTeX math notation and markdown formatting into natural spoken language before forwarding to any OpenAI-compatible TTS engine. Drop it between [Open WebUI](https://github.com/open-webui/open-webui) (or any client) and your TTS backend. TTS engine hears *"x squared plus one over two"* instead of *"dollar sign backslash frac open brace…"*

Built to solve a specific gap: self-hosted TTS engines like [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) produce great audio, but they read LaTeX markup character-by-character. If you use your LLM for anything math or science related, the TTS output is unusable without a preprocessing layer. This is that layer.

## What it does

```
Open WebUI (:3000) → tts-latex-proxy (:8881) → Kokoro-FastAPI (:8880)
```

The proxy intercepts `/v1/audio/speech` requests, processes the input text, then forwards the cleaned version to your TTS backend. All other API calls (models, health checks) pass through transparently.

**The cleaning pipeline:**

1. Strip fenced code blocks
2. Convert display math (`$$...$$`, `\[...\]`) to spoken English via [Speech Rule Engine](https://github.com/Speech-Rule-Engine/speech-rule-engine)
3. Convert inline math (`$...$`, `\(...\)`) to spoken English
4. Strip markdown formatting (bold, italic, headers, links, lists, tables, blockquotes)
5. Collapse excess whitespace

### Before / After

| Raw LLM output | What the TTS engine receives |
|---|---|
| `$\frac{a}{b}$` | a over b |
| `$E = mc^2$` | E equals m c squared |
| `$\int_0^1 f(x) dx$` | the integral from 0 to 1 of f of x d x |
| `$\alpha + \beta$` | alpha plus beta |
| `$\sqrt{x^2 + y^2}$` | the square root of x squared plus y squared |
| `$\sum_{i=1}^{n} x_i$` | the sum from i equals 1 to n of x sub i |
| `$P(A \cup B)$` | P of open paren A union B close paren |

Markdown formatting (`**bold**`, `# Headers`, `[links](url)`, bullet lists, tables) is stripped silently.

## Quick start

### 1. Clone and build

```bash
git clone https://github.com/HanFarJR/tts-latex-proxy.git
cd tts-latex-proxy
docker build -t tts-latex-proxy .
```

### 2. Add to your Docker Compose stack
Example:

```yaml
services:
  tts-proxy:
    build: ./tts-latex-proxy       # or image: tts-latex-proxy
    container_name: tts-proxy
    ports:
      - "8881:8881"
    environment:
      - KOKORO_URL=http://kokoro-fastapi:8880    # your TTS backend
      - PORT=8881
    depends_on:
      - kokoro-fastapi
    restart: unless-stopped
```

### 3. Point your client at the proxy instead of the TTS backend

For Open WebUI, update these environment variables:

```yaml
  open-webui:
    environment:
      - AUDIO_TTS_ENGINE=openai
      - AUDIO_TTS_OPENAI_API_BASE_URL=http://tts-proxy:8881/v1    # proxy, not Kokoro directly
      - AUDIO_TTS_OPENAI_API_KEY=not-needed
      - AUDIO_TTS_MODEL=kokoro
      - AUDIO_TTS_VOICE=af_heart
```
Alternatively, these variables can be changed in the Open WebUI Admin Panel.

### 4. Verify

```bash
docker compose logs tts-proxy -f
```

You should see the SRE warmup confirmation and then before/after logs for each TTS request:

```
tts-proxy  | SRE warmup ok — \frac{a}{b} → "a over b"
tts-proxy  | TTS LaTeX proxy :8881 → http://kokoro-fastapi:8880
tts-proxy  | IN:  Calculation: $P(2 \cup 5) = P(2) + P(5) = \frac{1}{6} + \frac{1}{6} = \frac{2}{6}$ (or $\frac{1}{3}$…
tts-proxy  | OUT: Calculation: P of open paren 2 union 5 close paren equals P of 2 plus P of 5 equals one sixth plus o…
```

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `KOKORO_URL` | `http://kokoro-fastapi:8880` | Base URL of your TTS backend (any OpenAI-compatible `/v1/audio/speech` endpoint) |
| `PORT` | `8881` | Port the proxy listens on |

## Compatibility

The proxy works with any TTS backend that implements the OpenAI `/v1/audio/speech` endpoint:

- [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)
- [openedai-speech](https://github.com/matatonic/openedai-speech)
- [Chatterbox-TTS-Server](https://github.com/travisvn/chatterbox-tts-api)
- OpenAI API directly

And any client that sends text to a `/v1/audio/speech` endpoint:

- [Open WebUI](https://github.com/open-webui/open-webui)
- Custom applications using the OpenAI TTS API format

## How it works

The math-to-speech conversion is powered by [Speech Rule Engine (SRE)](https://speechruleengine.org/) via the [`latex-to-speech`](https://github.com/Speech-Rule-Engine/sre-latex) npm package, using the **clearspeak** rule set. SRE is the same engine behind MathJax accessibility and Google ChromeVox — it's the standard for math-to-speech in the accessibility world.

The proxy is a ~100-line Express server. It parses the request body, runs the text through the cleaning pipeline, and forwards the modified request to the upstream TTS backend. Audio responses are passed back transparently. No GPU, no ML model, near-zero resource usage.

## Attribution

The code in this repository was generated with the assistance of [Claude](https://claude.ai) (Anthropic). The project concept, architecture decisions, integration requirements, and testing were done by the author; the implementation was AI-assisted.
