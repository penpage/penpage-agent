import { readdirSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

// --- Types ---

export interface SessionData {
  sessionId?: string;
  runner?: string;
  model?: string;
  addDirs?: string[];
  totalCost?: number;
  totalTurns?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
}

export interface CommandContext {
  cwd: string;
  filename: string;
  sessionData: SessionData;
}

export interface CommandResult {
  markdown: string;
  sessionUpdate?: Partial<SessionData>;
  // Structured data for /sessions (web UI renders as clickable list)
  sessionList?: Array<{ sessionId: string; name: string; startedAt: number }>;
}

// --- Definitions ---

interface CommandDef {
  name: string;
  description: string;
  usage: string;
}

const COMMAND_DEFS: CommandDef[] = [
  { name: 'model', description: 'Show or change model', usage: '/model [N|name]' },
  { name: 'status', description: 'Show Claude Code status', usage: '/status' },
  { name: 'cost', description: 'Show session cost and usage', usage: '/cost' },
  { name: 'help', description: 'Show available commands', usage: '/help' },
  { name: 'resume', description: 'List sessions or resume one', usage: '/resume [id|N]' },
  { name: 'add-dir', description: 'Add directory access', usage: '/add-dir <path>' },
  { name: 'dirs', description: 'List directories', usage: '/dirs' },
  { name: 'clear', description: 'Clear session', usage: '/clear' },
];

export const AVAILABLE_MODELS = [
  { value: '', runner: 'claude', label: 'Claude' },
  { value: 'sonnet', runner: 'claude', label: 'Claude - Sonnet' },
  { value: 'opus', runner: 'claude', label: 'Claude - Opus' },
  { value: 'haiku', runner: 'claude', label: 'Claude - Haiku' },
  { value: '', runner: 'gemini', label: 'Gemini' },
  { value: 'gemini-2.5-pro', runner: 'gemini', label: 'Gemini - 2.5 Pro' },
  { value: 'gemini-2.5-flash', runner: 'gemini', label: 'Gemini - 2.5 Flash' },
  { value: 'gemini-2.0-flash', runner: 'gemini', label: 'Gemini - 2.0 Flash' },
  { value: '', runner: 'codex', label: 'Codex' },
  { value: 'o3', runner: 'codex', label: 'Codex - o3' },
  { value: 'o4-mini', runner: 'codex', label: 'Codex - o4-mini' },
  { value: 'codex-mini', runner: 'codex', label: 'Codex - codex-mini' },
];

// Commands only in web UI (not handled here)
const CLIENT_ONLY = new Set(['compact']);

// --- Parsing ---

export function parseCommand(input: string): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/([\w-]+)(.*)$/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (CLIENT_ONLY.has(name)) return null;
  // Don't treat /plan and /run as commands (they are triggers)
  if (name === 'plan' || name === 'run') return null;
  const args = match[2].trim().split(/\s+/).filter(Boolean);
  return { name, args };
}

// --- Execute ---

export async function executeCommand(
  name: string,
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult | null> {
  switch (name) {
    case 'model':
      return handleModel(args, ctx);
    case 'status':
      return handleStatus(ctx);
    case 'cost':
      return handleCost(ctx);
    case 'help':
      return handleHelp();
    case 'resume':
      return handleResume(args, ctx);
    case 'add-dir':
      return handleAddDir(args, ctx);
    case 'dirs':
      return handleDirs(ctx);
    case 'clear':
      return handleClear();
    default:
      return null;
  }
}

// --- Handlers ---

function handleModel(args: string[], ctx: CommandContext): CommandResult {
  const arg = args[0];
  const currentRunner = ctx.sessionData.runner || 'claude';
  const currentModel = ctx.sessionData.model || '';
  const currentLabel = AVAILABLE_MODELS.find(
    m => m.runner === currentRunner && m.value === currentModel
  )?.label || `${currentRunner}${currentModel ? ' - ' + currentModel : ''}`;

  if (!arg) {
    // Show numbered list
    const list = AVAILABLE_MODELS.map((m, i) => {
      const marker = (m.runner === currentRunner && m.value === currentModel) ? ' ←' : '';
      return `${i + 1}. ${m.label}${marker}`;
    }).join('\n');
    return {
      markdown: `**Models** (current: ${currentLabel}):\n\n${list}\n\nUse \`/model N\` to select.`,
    };
  }

  if (/^\d+$/.test(arg)) {
    const idx = parseInt(arg) - 1;
    if (idx >= 0 && idx < AVAILABLE_MODELS.length) {
      const selected = AVAILABLE_MODELS[idx];
      return {
        markdown: `Model set to **${selected.label}**.`,
        sessionUpdate: { runner: selected.runner, model: selected.value },
      };
    }
    return { markdown: `Invalid number (1-${AVAILABLE_MODELS.length}). Use \`/model\` to see options.` };
  }

  // Named selection
  return {
    markdown: `Model set to **${arg}**.`,
    sessionUpdate: { model: arg },
  };
}

function handleStatus(ctx: CommandContext): CommandResult {
  try {
    // 用最小 prompt 取得 Claude Code 的 init + result events
    const raw = execSync(
      'claude -p --output-format stream-json "reply OK"',
      { cwd: ctx.cwd, timeout: 15000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const events = raw.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    const init = events.find((e: any) => e.type === 'system' && e.subtype === 'init');
    const result = events.find((e: any) => e.type === 'result');
    const rateLimit = events.find((e: any) => e.type === 'rate_limit_event');

    const lines: string[] = [];
    lines.push('**Claude Code Status**\n');

    if (init) {
      lines.push(`- **Version**: ${init.claude_code_version || 'unknown'}`);
      lines.push(`- **Model**: ${init.model || 'unknown'}`);
      if (ctx.sessionData.model) {
        lines.push(`- **Pad model**: ${ctx.sessionData.model}`);
      }
      if (ctx.sessionData.sessionId) {
        lines.push(`- **Session**: \`${ctx.sessionData.sessionId.slice(0, 8)}\``);
      }
    }

    if (result?.total_cost_usd !== undefined) {
      lines.push(`- **Status check cost**: $${result.total_cost_usd.toFixed(4)}`);
    }

    if (rateLimit?.rate_limit_info) {
      const rl = rateLimit.rate_limit_info;
      lines.push(`- **Rate limit**: ${rl.status} (${rl.rateLimitType})`);
      if (rl.resetsAt) {
        const resetTime = new Date(rl.resetsAt * 1000).toLocaleString();
        lines.push(`- **Resets at**: ${resetTime}`);
      }
    }

    // 讀取近期 usage 統計
    const statsPath = join(homedir(), '.claude', 'stats-cache.json');
    try {
      const stats = JSON.parse(readFileSync(statsPath, 'utf-8'));
      if (stats.dailyActivity?.length) {
        const recent = stats.dailyActivity.slice(-7);
        const totalMessages = recent.reduce((sum: number, d: any) => sum + (d.messageCount || 0), 0);
        const totalTools = recent.reduce((sum: number, d: any) => sum + (d.toolCallCount || 0), 0);
        lines.push(`\n**Last 7 days:**`);
        lines.push(`- Messages: ${totalMessages}`);
        lines.push(`- Tool calls: ${totalTools}`);
      }
    } catch {
      // stats 讀不到沒關係
    }

    return { markdown: lines.join('\n') };
  } catch (err: any) {
    return { markdown: `**Status check failed**: ${err.message || 'unknown error'}` };
  }
}

function handleCost(ctx: CommandContext): CommandResult {
  const s = ctx.sessionData;
  if (!s.sessionId && !s.totalCost) {
    return { markdown: 'No active session. Use `/run` or `/plan` first.' };
  }
  const lines: string[] = [];
  lines.push('**Session Cost**\n');
  if (s.sessionId) {
    lines.push(`- **Session**: \`${s.sessionId.slice(0, 8)}\``);
  }
  if (s.model) {
    lines.push(`- **Model**: ${s.model}`);
  }
  lines.push(`- **Turns**: ${s.totalTurns || 0}`);
  lines.push(`- **Cost**: $${(s.totalCost || 0).toFixed(4)}`);
  if (s.totalInputTokens || s.totalOutputTokens) {
    const inK = ((s.totalInputTokens || 0) / 1000).toFixed(1);
    const outK = ((s.totalOutputTokens || 0) / 1000).toFixed(1);
    lines.push(`- **Tokens**: ${inK}k in / ${outK}k out`);
  }
  return { markdown: lines.join('\n') };
}

function handleHelp(): CommandResult {
  const lines = COMMAND_DEFS.map((c) => `\`${c.usage}\` — ${c.description}`);
  lines.push('`/plan` — Run in plan mode');
  lines.push('`/run` — Run in auto mode');
  return { markdown: `**Commands:**\n\n${lines.join('\n\n')}` };
}

function handleSessions(ctx: CommandContext): CommandResult {
  const sessionsDir = join(homedir(), '.claude', 'sessions');
  try {
    const sessions = readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const data = JSON.parse(readFileSync(join(sessionsDir, f), 'utf-8'));
          return {
            sessionId: data.sessionId as string,
            name: (data.name || 'unnamed') as string,
            cwd: data.cwd as string,
            startedAt: data.startedAt as number,
          };
        } catch {
          return null;
        }
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .filter((s) => !ctx.cwd || s.cwd === ctx.cwd)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 10);

    if (sessions.length === 0) {
      return { markdown: 'No recent sessions found.' };
    }

    const list = sessions.map((s, i) => {
      const date = new Date(s.startedAt);
      const timeStr = date.toLocaleString();
      const shortId = s.sessionId.slice(0, 8);
      return `${i + 1}. **${s.name}** \`${shortId}\` — ${timeStr}`;
    }).join('\n');

    return {
      markdown: `**Recent sessions:**\n\n${list}\n\nUse \`/resume N\` to resume.`,
      sessionList: sessions,
    };
  } catch {
    return { markdown: 'No recent sessions found.' };
  }
}

function handleResume(args: string[], ctx: CommandContext): CommandResult {
  const arg = args[0];
  if (!arg) {
    return handleSessions(ctx);
  }

  // Numbered selection (from previous /sessions list — resolve by listing again)
  if (/^\d+$/.test(arg)) {
    const sessionsResult = handleSessions(ctx);
    if (!sessionsResult.sessionList) {
      return { markdown: 'No sessions available.' };
    }
    const idx = parseInt(arg) - 1;
    if (idx >= 0 && idx < sessionsResult.sessionList.length) {
      const s = sessionsResult.sessionList[idx];
      const shortId = s.sessionId.slice(0, 8);
      return {
        markdown: `Resumed session **${s.name}** (\`${shortId}\`).`,
        sessionUpdate: { sessionId: s.sessionId },
      };
    }
    return { markdown: `Invalid number. Use \`/resume\` to see available sessions.` };
  }

  // Direct session ID
  return {
    markdown: `Resumed session \`${arg.slice(0, 8)}\`.`,
    sessionUpdate: { sessionId: arg },
  };
}

function handleAddDir(args: string[], ctx: CommandContext): CommandResult {
  const dir = args.join(' ');
  if (!dir) {
    return { markdown: 'Usage: `/add-dir <path>`' };
  }
  const current = ctx.sessionData.addDirs || [];
  if (current.includes(dir)) {
    return { markdown: `Directory already added: \`${dir}\`` };
  }
  return {
    markdown: `Added directory: \`${dir}\``,
    sessionUpdate: { addDirs: [...current, dir] },
  };
}

function handleDirs(ctx: CommandContext): CommandResult {
  const dirs = ctx.sessionData.addDirs || [];
  if (dirs.length === 0) {
    return { markdown: `**Project:** \`${ctx.cwd}\`\n\nNo additional directories.` };
  }
  const list = dirs.map((d) => `- \`${d}\``).join('\n');
  return { markdown: `**Project:** \`${ctx.cwd}\`\n**Additional dirs:**\n${list}` };
}

function handleClear(): CommandResult {
  return {
    markdown: 'Session cleared.',
    sessionUpdate: { sessionId: undefined, model: undefined, addDirs: undefined },
  };
}
