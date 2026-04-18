# Sniff

**An LLM-integrated interception proxy for paired pentesting.**

Sniff is an HTTP(S) interception proxy with a dedicated AI co-pilot built in. It captures the traffic passing through your browser, surfaces vulnerabilities as they appear, and lets you talk to an LLM with full session context — all locally, with your own AWS Bedrock API key.

![History view](docs/screenshots/history.png)

## Why

Existing proxy tools treat LLMs as an afterthought. Sniff flips that: every intercepted request is a candidate for analysis, every finding is generated with real evidence from real traffic, and the AI has direct access to your site map, scope, and session observations.

- **Bring your own key.** AWS Bedrock only right now (OpenAI/Anthropic API coming). Your credentials never leave your machine.
- **All data is local.** SQLite database, local CA, local cert store. No telemetry.
- **Open source, MIT-ish.** Fork it, extend it, add your own prompts.

## Features

| Tool | What it does |
|------|------|
| **Proxy / History** | Live MITM traffic capture with a searchable, filterable, virtualized history. |
| **Hold** | Pin requests for later, scoped per project. |
| **Failed** | Dedicated tab for proxy errors (TLS failures, DNS failures, timeouts) so History stays clean. |
| **Replay** | Tabbed request editor. Resend, follow redirects with cookie forwarding, download raw/decoded response bodies, diff history. |
| **Fuzzer** | Template-based fuzzing (Single, Parallel, Paired, Cartesian attack modes). LLM can generate context-aware payloads. |
| **Decoder** | Stackable encode/decode chain (base64, URL, HTML, hex, JWT, gzip). |
| **Comparer** | Side-by-side diff of requests or responses. |
| **Site Map** | Tree view of discovered hosts and paths from history. |
| **Scope** | Include/exclude rules with glob patterns, drag-to-reorder. |
| **Findings** | Deduplicated list of vulnerabilities the AI has discovered, grouped by host and sorted by CVSS. |
| **AI Activity** | Live feed of what the auto-analyzer is doing. Session observations update as it reasons about the target. |
| **Chat** | Project-scoped conversation with full context — scope, findings, endpoints, observations, recent traffic. Markdown rendering, action cards for "Send to Replay." |

### Screenshots

**Findings** — AI-discovered vulnerabilities, grouped by host, sorted by CVSS:
![Findings view](docs/screenshots/findings.png)

**AI Activity** — live analyzer queue with session observations about the target:
![AI Activity view](docs/screenshots/activity.png)

**Chat** — project-level conversation with action cards for follow-ups:
![Chat view](docs/screenshots/chat.png)

**Replay** — tabbed request editor with follow-redirect and response download:
![Replay view](docs/screenshots/replay.png)

**Site Map** — discovered endpoints as a tree:
![Site Map view](docs/screenshots/sitemap.png)

## Install

There are three ways to run Sniff.

### 1. Pre-built Electron app (easiest)

Download the latest release for your platform from the [Releases page](../../releases/latest).

- **macOS**: download the `.dmg`, drag Sniff to Applications.
- **Windows**: download the `.exe` installer, run it.
- **Linux**: download the `.AppImage`, `chmod +x`, run it.

Builds are unsigned — on macOS you may need `xattr -d com.apple.quarantine /Applications/Sniff.app` or right-click → Open the first time.

### 2. From source — Electron app

```bash
git clone https://github.com/YOUR_USER/sniff
cd sniff
npm install
npm run build
cd apps/electron
npx electron .
```

### 3. From source — in a browser

Good for development or if you just want to poke at the UI.

```bash
git clone https://github.com/YOUR_USER/sniff
cd sniff
npm install
npm run dev
# Open http://localhost:5173
```

The `dev` script starts:
- Backend (Fastify) on `127.0.0.1:47120`
- Renderer (Vite) on `127.0.0.1:5173`
- Proxy (HTTP/HTTPS MITM) on `:8080`

Requires Node.js 20+.

## Setup

### 1. Point your browser at the proxy

The proxy listens on `127.0.0.1:8080`. Configure your browser (or your OS) to use it as an HTTP/HTTPS proxy. A per-browser proxy switcher (FoxyProxy, etc.) is the most convenient option.

### 2. Install the CA certificate

The first time the proxy starts, Sniff generates a local root CA in `.sniff-certs/` (Electron build: `~/Library/Application Support/Sniff/certificates/` on macOS, similar on other OSes). You have to trust that CA in your browser (or OS) for HTTPS MITM to work.

Download it from **Settings → Certificate → Download CA**, then:
- **macOS**: open the `.pem`, add to Keychain, mark as "Always Trust" for SSL.
- **Linux**: copy to `/usr/local/share/ca-certificates/` and run `update-ca-certificates`.
- **Windows**: `certmgr.msc` → Trusted Root Certification Authorities → Import.
- **Firefox**: Settings → Certificates → View Certificates → Authorities → Import.

### 3. Add your AWS Bedrock credentials (optional, enables AI features)

In **Settings**, paste an AWS access key, secret, and region that has Bedrock model access. Sniff stores them in a local SQLite database — they never leave your machine.

Minimum models enabled on your account:
- **Fast** (`claude-haiku-4-5` or similar) — used for cheap, high-volume auto-analysis.
- **Reasoning** (`claude-sonnet-4-6`) — used for deeper findings and chat.
- **Deep** (`claude-opus-4-7`) — used for the most complex analysis (optional).

Without credentials, Sniff still works as a plain interception proxy; AI features are hidden.

## Architecture

```
┌─────────────────────────────────────┐       ┌─────────────────────┐
│  Electron / Browser                 │       │  Fastify Backend    │
│  React + Vite + Tailwind            │◀──────│  (127.0.0.1:47120)  │
│                                     │  HTTP │                     │
│  - History, Replay, Fuzzer...       │  + WS │  - Routes           │
│  - Findings, AI Activity, Chat      │       │  - WebSocket hub    │
└─────────────────────────────────────┘       │  - Proxy engine     │
                                              │  - LLM client       │
                                              │    (Bedrock)        │
                                              │  - SQLite via       │
                                              │    Prisma           │
                                              └──────────┬──────────┘
                                                         │
                                                         ▼
                                              ┌─────────────────────┐
                                              │  MITM Proxy :8080   │
                                              │  - HTTP / HTTPS     │
                                              │  - Per-host certs   │
                                              │  - Intercept queue  │
                                              └─────────────────────┘
```

The backend is `127.0.0.1`-bound and enforces a Host-header allow-list to protect against DNS rebinding attacks from malicious websites.

## Project layout

```
sniff/
├── apps/
│   ├── backend/   Fastify server, Prisma schema, proxy engine, LLM pipeline
│   ├── electron/  Thin Electron shell that boots the backend and loads the renderer
│   └── renderer/  React + Vite SPA
├── packages/
│   └── shared/    Types & constants shared between backend and renderer
└── scripts/       dev / build / test wrappers
```

## Development

```bash
npm run dev         # Start backend + renderer in watch mode
npm run build       # Build renderer and electron
npm run test        # Unit + proxy integration
npm run test:e2e    # Playwright end-to-end
npm run lint
```

DB schema lives in `apps/backend/prisma/schema.prisma`. `npm run dev` auto-runs `prisma db push` on boot; no manual migrations needed.

## Security notes

- The backend binds to `127.0.0.1` only and rejects requests whose `Host` header is not a loopback address. This mitigates DNS-rebinding attacks from malicious web pages.
- AWS credentials are stored unencrypted in the local SQLite database. The database is gitignored and lives in your user data directory. For a hardened setup, use an AWS profile + IAM role instead of pasting long-lived access keys.
- The Replay tool can hit any URL you type, including internal IPs (`169.254.169.254`, `10.x.x.x`). That's by design — it's a pentesting tool — but be aware that a compromised LLM prompt could theoretically suggest internal URLs. Review suggestions before clicking **Send to Replay**.
- Pre-built releases are unsigned. If you need signed binaries, build from source.

## License

MIT — see [LICENSE](LICENSE).

## Disclaimer

Sniff is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by PortSwigger Ltd. or any of its products (including Burp Suite). Any resemblance in workflow or terminology reflects common conventions in the HTTP-proxy tooling space.
