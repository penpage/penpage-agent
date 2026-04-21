# @penpage/agent

A local web UI that bridges your browser with AI coding CLIs. Run prompts against **Claude Code**, **Gemini CLI**, or **Codex CLI** from a single chat interface with streaming responses, session management, and context tracking.

## Features

- **Multi-tool support** — Switch between Claude Code, Gemini CLI, and Codex CLI with one click
- **Streaming responses** — Real-time SSE streaming from CLI stdout
- **Session continuity** — Resume previous Claude Code sessions (`--resume`)
- **Session browser** — List recent sessions, preview last exchanges, and resume with one click
- **Context tracking** — Live progress bar showing token usage and context window consumption
- **Slash commands** — `/sessions`, `/resume`, `/cost`, `/model`, `/compact`, `/clear`, `/help`
- **Single port** — Fastify API + Vite dev server on one port (default 3456)

## Prerequisites

At least one AI coding CLI must be installed:

| Tool | Install |
|------|---------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `npm install -g @anthropic-ai/claude-code` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @anthropic-ai/gemini-cli` |
| [Codex CLI](https://github.com/openai/codex) | `npm install -g @openai/codex` |

## Quick Start

```bash
# Clone and install
git clone https://github.com/penpage/penpage-agent.git
cd penpage-agent
npm install

# Start dev server (defaults to current directory as project cwd)
npm run dev

# Or specify a project directory
npm run dev -- --cwd ~/my-project

# Custom port
npm run dev -- --port 4000
```

Open `http://localhost:3456` in your browser.

## Usage

1. Select an AI tool from the buttons above the input area
2. Type a prompt and press **Cmd+Enter** (or click **Run**)
3. Responses stream in real-time
4. Use `/sessions` to browse and resume previous Claude Code sessions

### Slash Commands

| Command | Description |
|---------|-------------|
| `/sessions` | List recent Claude Code sessions for the current project |
| `/resume [id]` | Resume a previous session (or pick from list) |
| `/cost` | Show current session cost |
| `/model [name]` | Set Claude model (e.g. `/model sonnet`) |
| `/compact` | Send compact prompt to reduce context |
| `/clear` | Clear chat display |
| `/help` | Show available commands |

## Architecture

```
src/
├── bin/cli.ts              # CLI entry point (--port, --cwd)
├── server/
│   ├── index.ts            # Fastify + Vite unified server
│   ├── routes/ai.ts        # API routes (tools, sessions, run)
│   └── runners/            # AI CLI adapters
│       ├── types.ts        # AIRunner interface
│       ├── claude.ts       # Claude Code (stream-json)
│       ├── gemini.ts       # Gemini CLI
│       └── codex.ts        # Codex CLI
└── client/
    ├── index.html          # Single page
    ├── app.ts              # Chat UI + session management
    └── styles/main.css     # Dark theme
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ai/tools` | List available AI tools |
| GET | `/api/ai/sessions` | List recent Claude sessions |
| GET | `/api/ai/sessions/:id/preview` | Preview session history |
| POST | `/api/ai/run` | Run prompt (SSE stream) |

## License

MIT
