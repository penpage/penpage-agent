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
- **Telegram Bot** — Vibe-code from your phone via Telegram, even behind corporate proxies. Send prompts, receive real-time responses, and control AI tools on the go
- **PenPage integration** — Full conversation history is saved as `.penpage/*.md` files, synced to [PenPage](https://penpage.com) for reading on any device

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

All commands work in both the web UI and Telegram (defined once in `commands.ts`):

| Command | Description |
|---------|-------------|
| `/model [N\|name]` | Show or change model |
| `/status` | Show Claude Code version, model, rate limits |
| `/cost` | Show session cost and token usage |
| `/resume [id\|N]` | List sessions or resume one |
| `/new` | Start new session (keep model/dirs) |
| `/clear` | Clear all session data |
| `/history [N]` | Show conversation history |
| `/add-dir <path>` | Add directory access |
| `/dirs` | List project + added directories |
| `/compact` | Compact Claude Code context (web UI only) |
| `/help` | Show available commands |
| `/ping` `/uptime` `/df` `/who` `/ip` `/mem` | System info |

## Telegram Bot

Send prompts and control AI tools from your phone via Telegram — even behind corporate HTTP proxies.

### Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram
2. Add the token to `.env` (copy from `.env.example`):
   ```env
   BOT_TOKEN=your_bot_token_here
   ALLOWED_USER_ID=your_numeric_user_id
   HTTPS_PROXY=http://proxy:port   # optional, for corporate firewalls
   ```
3. Run `npm run dev` — the bot starts automatically alongside the web UI
4. Send `/help` to your bot to see your User ID and available commands

No `BOT_TOKEN` = bot is silently skipped, web UI works as usual.

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/plan <prompt>` | Run AI in plan mode (read-only, no file edits) |
| `/run <prompt>` | Run AI in auto mode (can edit files) |
| `/model [N\|name]` | Show or switch model |
| `/cost` | Show session cost and token usage |
| `/status` | Show Claude Code version and rate limits |
| `/resume [id\|N]` | List or resume previous sessions |
| `/new` | Start a new session (keep model/dirs settings) |
| `/history [N]` | Show conversation history |
| `/add-dir <path>` | Add directory access for AI |
| `/dirs` | List project + added directories |
| `/ping` `/uptime` `/df` `/who` `/ip` `/mem` | System info commands |

Prompts can also end with `/plan` or `/run`:
```
Refactor UserService to async/await
/plan
```

### How It Works

```
Phone (Telegram)              Mac (penpage-agent)
─────────────────             ──────────────────
Send /plan prompt  ──────→   Bot receives message
                             Spawns claude -p (or gemini/codex)
                             Streams AI response
Get summary reply  ←──────   Sends last segment to Telegram
View full history  ←──────   Writes full output to .penpage/*.md
  on PenPage                   ↕ File Link sync to PenPage
```

- **Private chat** → saved to `.penpage/telegram.md`
- **Group chat** → saved to `.penpage/tg-{group-name}.md`
- Each chat maintains its own session (model, cost, history)
- Sessions persist across restarts via `.penpage/telegram-sessions.json`
- Concurrent protection: one AI prompt per chat at a time

## Architecture

```
src/
├── bin/cli.ts              # CLI entry point (--port, --cwd)
├── server/
│   ├── index.ts            # Fastify + Vite unified server
│   ├── commands.ts         # Unified slash commands (shared by all frontends)
│   ├── routes/ai.ts        # API routes (tools, sessions, run)
│   └── runners/            # AI CLI adapters
│       ├── types.ts        # AIRunner interface
│       ├── execute.ts      # Shared runPrompt() core
│       ├── claude.ts       # Claude Code (stream-json)
│       ├── gemini.ts       # Gemini CLI
│       └── codex.ts        # Codex CLI
├── telegram/
│   └── bot.ts              # Telegram Bot (grammy)
├── shared/
│   └── formatSession.ts    # Session info formatting
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
