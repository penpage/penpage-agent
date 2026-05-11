import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'fs';
import { execSync, exec } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { formatSessionLine, timeAgo } from '../shared/formatSession.js';

// --- Types ---

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/** 每個 page 獨立的 session 狀態 */
export interface PageSessionState {
  sessionId?: string;
  totalCost?: number;
  totalTurns?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  messages?: ChatMessage[];
}

export interface SessionData {
  sessionId?: string;
  runner?: string;
  model?: string;
  addDirs?: string[];
  totalCost?: number;
  totalTurns?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  /** 對話紀錄，用於 session 失效時重建 context */
  messages?: ChatMessage[];
  /** Telegram/WebUI: 當前目標 md file（如 '05-04 指令.md'） */
  targetPage?: string;
  /** 每個 page 獨立的 session 資料（key = filename） */
  pageSessions?: Record<string, PageSessionState>;
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
  /** 特殊動作：'compact' 告知呼叫端執行 CLI compact */
  action?: 'compact';
}

// --- Definitions ---

interface CommandDef {
  name: string;
  description: string;
  usage: string;
}

const COMMAND_DEFS: CommandDef[] = [
  { name: 'model', description: 'Show or change model', usage: '/model [N|name]' },
  { name: 'diag', description: 'Show Claude Code diagnostics', usage: '/diag' },
  { name: 'cost', description: 'Show session cost and usage', usage: '/cost' },
  { name: 'help', description: 'Show available commands', usage: '/help' },
  { name: 'session', description: 'List/resume sessions or show details', usage: '/session [N|info N]' },
  { name: 'add-dir', description: 'Add directory access', usage: '/add-dir <path>' },
  { name: 'dirs', description: 'List directories', usage: '/dirs' },
  { name: 'new', description: 'Start new session (keep model/dirs)', usage: '/new' },
  { name: 'clear', description: 'Clear all session data', usage: '/clear' },
  { name: 'history', description: 'Show conversation history', usage: '/history [N]' },
  { name: 'ls', description: 'List recent pages/sessions/plans', usage: '/ls [page|session|plan]' },
  { name: 'compact', description: 'Compact Claude context window', usage: '/compact' },
  { name: 'page', description: 'List pages or switch target', usage: '/page [N|name|info]' },
  { name: 'ping', description: 'Ping test', usage: '/ping' },
  { name: 'uptime', description: 'System uptime', usage: '/uptime' },
  { name: 'df', description: 'Disk usage', usage: '/df' },
  { name: 'who', description: 'Current user & hostname', usage: '/who' },
  { name: 'ip', description: 'External IP address', usage: '/ip' },
  { name: 'mem', description: 'Memory info', usage: '/mem' },
];

const SHELL_COMMANDS: Record<string, string> = {
  ping: 'echo pong',
  uptime: 'uptime',
  df: 'df -h',
  who: 'whoami && hostname',
  ip: 'curl -s ifconfig.me',
  mem: 'top -l 1 -s 0 | head -n 10',
};

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
const CLIENT_ONLY = new Set<string>();

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
    case 'diag':
      return handleStatus(ctx);
    case 'cost':
      return handleCost(ctx);
    case 'help':
      return handleHelp();
    case 'add-dir':
      return handleAddDir(args, ctx);
    case 'dirs':
      return handleDirs(ctx);
    case 'new':
      return handleNew(ctx);
    case 'clear':
      return handleClear();
    case 'history':
      return handleHistory(args, ctx);
    case 'compact':
      return handleCompact(ctx);
    case 'ls':
    case 'list':
      return handleLs(args, ctx);
    case 'page':
      return handlePage(args, ctx);
    case 'session':
      return handleSession(args, ctx);
    case 'ping':
    case 'uptime':
    case 'df':
    case 'who':
    case 'ip':
    case 'mem':
      return handleShell(name);
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
      'claude -p --no-session-persistence --output-format stream-json "reply OK"',
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

/** /session — 列出 sessions、恢復、或顯示詳情 */
function handleSession(args: string[], ctx: CommandContext): CommandResult {
  const sub = args[0]?.toLowerCase();
  const DEFAULT_LIMIT = 10;

  // /session info N — 顯示指定 session 詳情
  if (sub === 'info') {
    const target = args[1];
    if (!target) {
      return { markdown: 'Usage: `/session info <number>` — show session details with token usage.' };
    }

    // 找到目標 session
    const addDirs = ctx.sessionData.addDirs;
    const sessions = getMergedSessions(ctx.cwd, addDirs);
    let entry: SessionEntry | undefined;
    if (/^\d+$/.test(target)) {
      const idx = parseInt(target) - 1;
      if (idx >= 0 && idx < sessions.length) entry = sessions[idx];
    } else {
      // 用 sessionId prefix 匹配
      entry = sessions.find(s => s.sessionId.startsWith(target));
    }
    if (!entry) {
      return { markdown: `Session not found: \`${target}\`. Use \`/session\` to list.` };
    }

    return { markdown: getSessionDetail(entry, ctx.cwd) };
  }

  // /session N — resume 第 N 個 session
  if (sub && /^\d+$/.test(sub)) {
    const sessions = getMergedSessions(ctx.cwd, ctx.sessionData.addDirs);
    const idx = parseInt(sub) - 1;
    if (idx >= 0 && idx < sessions.length) {
      const s = sessions[idx];
      const shortId = s.sessionId.slice(0, 8);
      return {
        markdown: `Resumed session **${s.name}** (\`${shortId}\`).`,
        sessionUpdate: { sessionId: s.sessionId },
      };
    }
    return { markdown: `Invalid number. Use \`/session\` to see available sessions.` };
  }

  // /session <string> — resume by session ID
  if (sub && sub !== 'info') {
    return {
      markdown: `Resumed session \`${sub.slice(0, 8)}\`.`,
      sessionUpdate: { sessionId: sub },
    };
  }

  // /session（無參數）= 列出 sessions
  const items = listSessions(ctx.cwd, DEFAULT_LIMIT, ctx.sessionData.addDirs);
  if (items.length === 0) return { markdown: 'No sessions found.' };
  const list = items.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return { markdown: `**Sessions:**\n\n${list}\n\nUse \`/session N\` to resume.` };
}

/** 掃描 JSONL 彙總 session 詳情 */
function getSessionDetail(entry: SessionEntry, cwd: string): string {
  const projectDir = getProjectDir(cwd);
  const jsonlPath = join(projectDir, `${entry.sessionId}.jsonl`);

  // 從 sessions-index.json 取額外 metadata
  let indexEntry: any = null;
  try {
    const indexPath = join(projectDir, 'sessions-index.json');
    const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
    indexEntry = (data.entries || []).find((e: any) => e.sessionId === entry.sessionId);
  } catch {}

  // 掃描 JSONL 彙總 token usage
  let userMsgs = 0;
  let assistantMsgs = 0;
  let toolUses = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;

  if (existsSync(jsonlPath)) {
    try {
      const content = readFileSync(jsonlPath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'user') userMsgs++;
          if (obj.type === 'assistant') {
            assistantMsgs++;
            const usage = obj.message?.usage;
            if (usage) {
              inputTokens += usage.input_tokens || 0;
              outputTokens += usage.output_tokens || 0;
              cacheReadTokens += usage.cache_read_input_tokens || 0;
              cacheCreateTokens += usage.cache_creation_input_tokens || 0;
            }
            // 計算 tool_use 數量
            const content = obj.message?.content;
            if (Array.isArray(content)) {
              toolUses += content.filter((b: any) => b.type === 'tool_use').length;
            }
          }
        } catch { /* skip malformed line */ }
      }
    } catch { /* JSONL 不可讀 */ }
  }

  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens;
  const shortId = entry.sessionId.slice(0, 8);

  // 格式化輸出
  const lines: string[] = [];
  lines.push(`## Session \`${shortId}\``);
  lines.push('');

  // 基本資訊
  lines.push(`**Name:** ${entry.name}`);
  lines.push(`**ID:** \`${entry.sessionId}\``);
  if (indexEntry?.gitBranch) lines.push(`**Branch:** ${indexEntry.gitBranch}`);
  if (indexEntry?.created) lines.push(`**Created:** ${new Date(indexEntry.created).toLocaleString()}`);
  if (indexEntry?.modified) lines.push(`**Modified:** ${new Date(indexEntry.modified).toLocaleString()}`);
  lines.push('');

  // 對話統計
  lines.push('**Messages:**');
  lines.push(`- User: ${userMsgs}`);
  lines.push(`- Assistant: ${assistantMsgs}`);
  lines.push(`- Tool uses: ${toolUses}`);
  if (entry.messageCount) lines.push(`- Total (index): ${entry.messageCount}`);
  lines.push('');

  // Token 用量
  if (totalTokens > 0) {
    lines.push('**Tokens:**');
    lines.push(`- Input: ${inputTokens.toLocaleString()}`);
    lines.push(`- Output: ${outputTokens.toLocaleString()}`);
    lines.push(`- Cache read: ${cacheReadTokens.toLocaleString()}`);
    lines.push(`- Cache create: ${cacheCreateTokens.toLocaleString()}`);
    lines.push(`- **Total: ${totalTokens.toLocaleString()}**`);
    lines.push('');
  }

  // 首筆 prompt
  if (indexEntry?.firstPrompt) {
    const prompt = indexEntry.firstPrompt.replace(/<[^>]*>/g, '').trim().slice(0, 100);
    lines.push(`**First prompt:** ${prompt}${indexEntry.firstPrompt.length > 100 ? '…' : ''}`);
  }

  return lines.join('\n');
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

function handleNew(ctx: CommandContext): CommandResult {
  const oldSid = ctx.sessionData.sessionId;
  const oldTurns = ctx.sessionData.totalTurns || 0;
  const kept: string[] = [];
  if (ctx.sessionData.model) kept.push(`model: ${ctx.sessionData.model}`);
  if (ctx.sessionData.addDirs?.length) kept.push(`dirs: ${ctx.sessionData.addDirs.length}`);
  const keptInfo = kept.length > 0 ? `\nKept: ${kept.join(', ')}` : '';
  const oldInfo = oldSid ? ` (was ${oldSid.slice(0, 7)}, ${oldTurns} turns)` : '';
  return {
    markdown: `New session started${oldInfo}.${keptInfo}`,
    sessionUpdate: {
      sessionId: undefined,
      totalCost: 0,
      totalTurns: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      messages: [],
    },
  };
}

function handleClear(): CommandResult {
  return {
    markdown: 'Session cleared (all settings reset).',
    sessionUpdate: {
      sessionId: undefined,
      model: undefined,
      addDirs: undefined,
      totalCost: 0,
      totalTurns: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      messages: [],
    },
  };
}

function handleHistory(args: string[], ctx: CommandContext): CommandResult {
  const messages = ctx.sessionData.messages || [];
  if (messages.length === 0) {
    return { markdown: 'No conversation history.' };
  }
  const count = args[0] ? Math.min(parseInt(args[0]) * 2, messages.length) : messages.length;
  const recent = messages.slice(-count);
  const lines = recent.map((m) => {
    const label = m.role === 'user' ? '👤' : '🤖';
    const preview = m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
    return `${label} ${preview}`;
  });
  return { markdown: `**History** (${messages.length} messages):\n\n${lines.join('\n\n')}` };
}

// --- /compact handler ---

function handleCompact(ctx: CommandContext): CommandResult {
  if (!ctx.sessionData.sessionId) {
    return { markdown: 'No active session to compact.' };
  }
  return {
    markdown: '⏳ Compacting context...',
    action: 'compact',
  };
}

// --- /ls handler ---

/** 列出 .penpage/*.md 檔案（按 mtime 排序） */
function listPages(cwd: string, limit: number): string[] {
  const promptDir = join(cwd, '.penpage');
  if (!existsSync(promptDir)) return [];
  try {
    return readdirSync(promptDir)
      .filter(f => f.endsWith('.md'))
      .map(f => ({ name: f, mtime: statSync(join(promptDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map(f => {
        const name = f.name.replace(/\.md$/, '');
        return `${name} — ${timeAgo(f.mtime)}`;
      });
  } catch { return []; }
}

interface SessionEntry {
  sessionId: string;
  name: string;
  startedAt: number;
  modifiedAt?: number;
  messageCount?: number;
  totalCost?: number;
  totalTurns?: number;
  projectName?: string;
  pageFile?: string;
  entrypoint?: string;
}

/** 讀取 .penpage/.sessions.json 中的 page sessions */
function listPageSessions(cwd: string): SessionEntry[] {
  const sessionsFile = join(cwd, '.penpage', '.sessions.json');
  try {
    const data = JSON.parse(readFileSync(sessionsFile, 'utf-8'));
    return Object.entries(data)
      .filter(([, v]) => (v as any)?.sessionId)
      .map(([filename, v]) => {
        const s = v as any;
        // 用 .penpage/ 下對應 .md 檔的 mtime 作為時間
        let mtime = 0;
        try {
          mtime = statSync(join(cwd, '.penpage', filename)).mtimeMs;
        } catch {}
        return {
          sessionId: s.sessionId as string,
          name: filename.replace(/\.md$/, ''),
          startedAt: mtime,
          totalCost: s.totalCost as number | undefined,
          totalTurns: s.totalTurns as number | undefined,
          pageFile: filename,
        };
      });
  } catch { return []; }
}

/** CLI session 回傳型別（帶檔案路徑） */
interface CliSessionEntry extends SessionEntry {
  _cliJsonPath?: string;
}

/** 讀取 ~/.claude/sessions/*.json 中的 CLI sessions */
function listCliSessions(cwd: string): CliSessionEntry[] {
  const sessionsDir = join(homedir(), '.claude', 'sessions');
  try {
    return readdirSync(sessionsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const filePath = join(sessionsDir, f);
          const data = JSON.parse(readFileSync(filePath, 'utf-8'));
          return {
            sessionId: data.sessionId as string,
            name: (data.name || 'unnamed') as string,
            startedAt: data.startedAt as number,
            cwd: data.cwd as string,
            _cliJsonPath: filePath,
          };
        } catch { return null; }
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .filter(s => !cwd || s.cwd === cwd)
      .map(({ cwd: _cwd, ...rest }) => rest);
  } catch { return []; }
}

/** 從 firstPrompt 提取 session 名稱（移除 system tags，截斷 40 字） */
function extractSessionName(firstPrompt?: string): string {
  if (!firstPrompt) return 'unnamed';
  const text = firstPrompt.replace(/<[^>]*>/g, '').trim();
  return text ? text.slice(0, 40) : 'unnamed';
}

/** 取得 project sessions-index.json 路徑 */
function getProjectDir(cwd: string): string {
  const projectDirName = cwd.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', projectDirName);
}

/** 從 cwd 提取 project 短名（最後一段路徑） */
function extractProjectName(cwd: string): string {
  return cwd.replace(/\/+$/, '').split('/').pop() || 'unknown';
}

/** 讀取 project sessions：JSONL 掃描為主，sessions-index.json 補充 metadata */
function listProjectSessions(cwd: string): SessionEntry[] {
  const projectDir = getProjectDir(cwd);
  if (!existsSync(projectDir)) return [];
  const projectName = extractProjectName(cwd);

  // 1. 從 sessions-index.json 建立 metadata lookup（messageCount 等）
  // 注意：index 有已知 bug，不會即時更新，僅作為補充來源
  const indexLookup = new Map<string, any>();
  try {
    const indexPath = join(projectDir, 'sessions-index.json');
    const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
    for (const e of (data.entries || [])) {
      if (!e.isSidechain) indexLookup.set(e.sessionId, e);
    }
  } catch {}

  // 2. 掃描所有 JSONL 檔案（主要資料來源）
  const results: SessionEntry[] = [];
  try {
    for (const f of readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))) {
      const sessionId = f.replace(/\.jsonl$/, '');
      const fullPath = join(projectDir, f);
      const mtime = statSync(fullPath).mtimeMs;
      const idx = indexLookup.get(sessionId);

      // 讀 JSONL 取名稱和 entrypoint
      const meta = extractMetaFromJsonl(fullPath);
      // 名稱優先用 index（有 customTitle/agentName），否則用 JSONL
      let name = idx?.customTitle || idx?.agentName || meta.name;
      if (!name) name = 'unnamed';

      results.push({
        sessionId,
        name,
        startedAt: idx ? new Date(idx.created).getTime() : mtime,
        modifiedAt: idx ? new Date(idx.modified).getTime() : mtime,
        messageCount: idx?.messageCount,
        projectName,
        entrypoint: meta.entrypoint,
      });
    }
  } catch {}

  return results;
}

/** 從 JSONL 前 8KB 提取第一條 user message 的名稱和 entrypoint */
function extractMetaFromJsonl(fullPath: string): { name: string; entrypoint: string } {
  try {
    const chunk = readFileSync(fullPath, { encoding: 'utf-8', flag: 'r' }).slice(0, 8192);
    let entrypoint = '';
    let firstCommand = '';
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'user' || obj.isMeta) continue;
        // 取第一個 user message 的 entrypoint
        if (!entrypoint) entrypoint = obj.entrypoint || '';
        const msg = obj.message;
        // 跳過 tool_result（content 是 array）
        if (typeof msg?.content !== 'string') continue;
        let text = msg.content;
        // 記住第一個指令名稱作為 fallback
        if (!firstCommand && text.includes('<command-name>')) {
          const m = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
          if (m) firstCommand = m[1].trim();
          continue;
        }
        // 移除 XML tags，正規化空白
        text = text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        if (text) return { name: text.slice(0, 40), entrypoint };
      } catch {}
    }
    return { name: firstCommand ? `/${firstCommand}` : '', entrypoint };
  } catch {}
  return { name: '', entrypoint: '' };
}

/** 合併三個 store，sessionId 去重但互相補充欄位。支援多 cwd（跨 project） */
function getMergedSessions(cwd: string, addDirs?: string[]): SessionEntry[] {
  const cwds = [cwd, ...(addDirs || [])];
  const map = new Map<string, SessionEntry>();

  for (const dir of cwds) {
    // project sessions 先加（有 messageCount、modifiedAt、projectName）
    for (const s of listProjectSessions(dir)) {
      if (!map.has(s.sessionId)) map.set(s.sessionId, { ...s });
    }
    // CLI sessions 補充 startedAt，但不用 'unnamed' 覆蓋已有名稱
    for (const s of listCliSessions(dir)) {
      const existing = map.get(s.sessionId);
      if (existing) {
        if (s.startedAt) existing.startedAt = s.startedAt;
        if (s.name && s.name !== 'unnamed') {
          existing.name = s.name;
        } else if (existing.name && existing.name !== 'unnamed' && s._cliJsonPath) {
          // CLI name 是 unnamed 但 project 有好名稱 → 寫回 CLI JSON
          try {
            const data = JSON.parse(readFileSync(s._cliJsonPath, 'utf-8'));
            data.name = existing.name;
            writeFileSync(s._cliJsonPath, JSON.stringify(data));
          } catch {}
        }
      } else {
        map.set(s.sessionId, { ...s });
      }
    }
    // page sessions 補充 pageFile/cost/turns，保留已有的 name、projectName、entrypoint
    for (const s of listPageSessions(dir)) {
      const existing = map.get(s.sessionId);
      if (existing) {
        existing.pageFile = s.pageFile;
        existing.totalCost = s.totalCost ?? existing.totalCost;
        existing.totalTurns = s.totalTurns ?? existing.totalTurns;
        existing.messageCount = existing.messageCount ?? s.messageCount;
      } else {
        map.set(s.sessionId, { ...s });
      }
    }
  }

  return [...map.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** 列出 Claude sessions（合併 CLI + page sessions） */
/** 從 JSONL 尾部讀取最後一筆 assistant usage，回傳 context 使用百分比 */
function getContextPercent(sessionId: string, cwd: string): string {
  const jsonlPath = join(getProjectDir(cwd), `${sessionId}.jsonl`);
  try {
    const fd = openSync(jsonlPath, 'r');
    try {
      const fileSize = statSync(jsonlPath).size;
      // 讀尾部 32KB（通常足夠找到最後幾筆 assistant）
      const tailSize = Math.min(32768, fileSize);
      const buf = Buffer.alloc(tailSize);
      readSync(fd, buf, 0, tailSize, fileSize - tailSize);
      const chunk = buf.toString('utf-8');
      const lines = chunk.split('\n').reverse();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'assistant' && obj.message?.usage) {
            const u = obj.message.usage;
            const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            // Opus 200K context window
            const pct = Math.round((ctx / 200000) * 100);
            return `${pct}%`;
          }
        } catch {}
      }
    } finally { closeSync(fd); }
  } catch {}
  return '';
}

function listSessions(cwd: string, limit: number, addDirs?: string[]): string[] {
  const cwds = [cwd, ...(addDirs || [])];
  return getMergedSessions(cwd, addDirs)
    .slice(0, limit)
    .map(s => {
      const id = s.sessionId.slice(0, 8);
      const ago = timeAgo(s.startedAt).replace(' ago', '');
      // 從任一 project dir 找 context percent
      let ctx = '';
      for (const dir of cwds) {
        ctx = getContextPercent(s.sessionId, dir);
        if (ctx) break;
      }
      const ctxStr = ctx ? ` ${ctx}` : '';
      const src = s.entrypoint === 'sdk-cli' ? ' bot' : ' cli';
      const proj = s.projectName || '';
      const page = s.pageFile ? ` [${s.pageFile}]` : '';
      // 有 pageFile 時用 pageFile 作為名稱，不重複顯示 name
      const displayName = s.pageFile ? page : ` ${s.name}`;
      return `${proj}/${id} ${ago}${ctxStr}${src}${displayName}`;
    });
}

/** 列出 ~/.claude/plans/*.md（按 mtime 排序，讀第一行 # title） */
function listPlans(limit: number): string[] {
  const plansDir = join(homedir(), '.claude', 'plans');
  if (!existsSync(plansDir)) return [];
  try {
    return readdirSync(plansDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const fullPath = join(plansDir, f);
        const mtime = statSync(fullPath).mtimeMs;
        let title = f.replace(/\.md$/, '');
        try {
          const first = readFileSync(fullPath, 'utf-8').split('\n', 1)[0];
          if (first.startsWith('# ')) title = first.slice(2).trim();
        } catch {}
        return { title, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map(p => `${p.title} — ${timeAgo(p.mtime)}`);
  } catch { return []; }
}

function handleLs(args: string[], ctx: CommandContext): CommandResult {
  const sub = args[0]?.toLowerCase();
  const DEFAULT_LIMIT = 10;
  const SUMMARY_LIMIT = 3;

  // 解析自訂筆數（例如 /ls session 5）
  const numArg = args.find(a => /^\d+$/.test(a));
  const customLimit = numArg ? parseInt(numArg, 10) : undefined;

  // /ls page
  if (sub === 'page' || sub === 'pages') {
    const items = listPages(ctx.cwd, customLimit ?? DEFAULT_LIMIT);
    if (items.length === 0) return { markdown: 'No pages found.' };
    const list = items.map((s, i) => `${i + 1}. ${s}`).join('\n');
    return { markdown: `**Pages:**\n\n${list}` };
  }

  // /ls session
  if (sub === 'session' || sub === 'sessions') {
    const items = listSessions(ctx.cwd, customLimit ?? DEFAULT_LIMIT, ctx.sessionData.addDirs);
    if (items.length === 0) return { markdown: 'No sessions found.' };
    const list = items.map((s, i) => `${i + 1}. ${s}`).join('\n');
    return { markdown: `**Sessions:**\n\n${list}\n\nUse \`/session N\` to resume.` };
  }

  // /ls plan
  if (sub === 'plan' || sub === 'plans') {
    const items = listPlans(customLimit ?? DEFAULT_LIMIT);
    if (items.length === 0) return { markdown: 'No plans found.' };
    const list = items.map((s, i) => `${i + 1}. ${s}`).join('\n');
    return { markdown: `**Plans:**\n\n${list}` };
  }

  // /ls（無參數）→ 各類前 N 筆摘要
  const limit = customLimit ?? SUMMARY_LIMIT;
  const sections: string[] = [];

  const pages = listPages(ctx.cwd, limit);
  if (pages.length > 0) {
    const list = pages.map((s, i) => ` ${i + 1}. ${s}`).join('\n');
    sections.push(`📄 **Pages:**\n${list}`);
  }

  const sessions = listSessions(ctx.cwd, limit, ctx.sessionData.addDirs);
  if (sessions.length > 0) {
    const list = sessions.map((s, i) => ` ${i + 1}. ${s}`).join('\n');
    sections.push(`🔗 **Sessions:**\n${list}`);
  }

  const plans = listPlans(limit);
  if (plans.length > 0) {
    const list = plans.map((s, i) => ` ${i + 1}. ${s}`).join('\n');
    sections.push(`📋 **Plans:**\n${list}`);
  }

  if (sections.length === 0) {
    return { markdown: 'No recent activity.' };
  }

  return {
    markdown: `**Recent:**\n\n${sections.join('\n\n')}\n\nUse \`/ls page\`, \`/ls session\`, \`/ls plan\` for full list.`,
  };
}

/**
 * 切換 page 時，儲存當前 session 到 pageSessions，並恢復目標 page 的 session。
 * 回傳需要 merge 到 sessionData 的 partial update。
 */
function switchPage(sessionData: SessionData, newTarget: string | undefined): Partial<SessionData> {
  if (!sessionData.pageSessions) sessionData.pageSessions = {};
  const currentPage = sessionData.targetPage || '__default__';

  // 儲存當前 page 的 session 狀態
  sessionData.pageSessions[currentPage] = {
    sessionId: sessionData.sessionId,
    totalCost: sessionData.totalCost,
    totalTurns: sessionData.totalTurns,
    totalInputTokens: sessionData.totalInputTokens,
    totalOutputTokens: sessionData.totalOutputTokens,
    messages: sessionData.messages,
  };

  // 恢復目標 page 的 session 狀態
  const targetKey = newTarget || '__default__';
  const restored = sessionData.pageSessions[targetKey];

  return {
    targetPage: newTarget,
    sessionId: restored?.sessionId ?? undefined,
    totalCost: restored?.totalCost ?? 0,
    totalTurns: restored?.totalTurns ?? 0,
    totalInputTokens: restored?.totalInputTokens ?? 0,
    totalOutputTokens: restored?.totalOutputTokens ?? 0,
    messages: restored?.messages ?? [],
    pageSessions: sessionData.pageSessions,
  };
}

function formatPageInfo(filename: string, s: SessionData | undefined): string {
  const name = filename.replace(/\.md$/, '');
  if (!s) return `**${name}** — no session`;
  const parts: string[] = [`**${name}**`];
  const sid = s.sessionId ? s.sessionId.slice(0, 8) : '-';
  const turns = s.totalTurns || 0;
  const cost = (s.totalCost || 0).toFixed(4);
  parts.push(`${sid} | ${turns} turns | $${cost}`);
  if (s.totalInputTokens || s.totalOutputTokens) {
    const inK = ((s.totalInputTokens || 0) / 1000).toFixed(1);
    const outK = ((s.totalOutputTokens || 0) / 1000).toFixed(1);
    parts[1] += ` | ${inK}k/${outK}k`;
  }
  if (s.addDirs?.length) parts.push(`dirs: ${s.addDirs.join(', ')}`);
  return parts.join('\n');
}

function handlePage(args: string[], ctx: CommandContext): CommandResult {
  const promptDir = join(ctx.cwd, '.penpage');
  if (!existsSync(promptDir)) {
    return { markdown: 'No .penpage directory found.' };
  }

  // 依修改時間排序（最近的在前）
  const files = readdirSync(promptDir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ name: f, mtime: statSync(join(promptDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(f => f.name);
  if (files.length === 0) {
    return { markdown: 'No pages found in .penpage/' };
  }

  const arg = args.join(' ').trim();

  // /page → 簡潔列表（只顯示編號 + 名稱 + ★ 標記）
  if (!arg) {
    const currentTarget = ctx.sessionData.targetPage || null;
    const lines = files.map((f, i) => {
      const mark = f === currentTarget ? '★' : ' ';
      const name = f.replace(/\.md$/, '');
      return `${mark}${i + 1}. ${name}`;
    });
    const header = currentTarget
      ? `**Current:** ${currentTarget.replace(/\.md$/, '')}`
      : '**Current:** (default)';
    return { markdown: `${header}\n\n${lines.join('\n')}` };
  }

  // /page info [N] → 詳細資訊
  if (args[0]?.toLowerCase() === 'info') {
    const sessions = loadFileSessions(promptDir);

    if (args[1] && /^\d+$/.test(args[1])) {
      // /page info N → 指定 page
      const idx = parseInt(args[1]) - 1;
      if (idx < 0 || idx >= files.length) {
        return { markdown: `Invalid number (1-${files.length}). Use \`/page\` to see list.` };
      }
      const f = files[idx];
      return { markdown: formatPageInfo(f, sessions[f]) };
    }

    // /page info → 所有 pages 的詳細資訊
    const currentTarget = ctx.sessionData.targetPage || null;
    const blocks = files.map((f, i) => {
      const mark = f === currentTarget ? '★' : ' ';
      return `${mark}${i + 1}. ${formatPageInfo(f, sessions[f])}`;
    });
    return { markdown: blocks.join('\n\n') };
  }

  // /page new <name> → 建立新 .md 檔案
  if (args[0]?.toLowerCase() === 'new') {
    const name = args.slice(1).join(' ').trim();
    if (!name) {
      return { markdown: 'Usage: `/page new <name>`\nExample: `/page new 05-06 refactor`' };
    }
    const filename = name.endsWith('.md') ? name : `${name}.md`;
    const filePath = join(promptDir, filename);
    if (existsSync(filePath)) {
      // 檔案已存在，直接切換
      const switchResult = switchPage(ctx.sessionData, filename);
      return {
        markdown: `Page already exists, switched to: **${name}**`,
        sessionUpdate: switchResult,
      };
    }
    // 建立帶 # title header 的新檔案
    const title = name.replace(/\.md$/, '');
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${now.toTimeString().slice(0, 5)}`;
    const header = `# ${title}\n\nCreated: ${dateStr}\n\n---\n`;
    writeFileSync(filePath, header);
    const switchResult = switchPage(ctx.sessionData, filename);
    return {
      markdown: `Created and switched to: **${title}**`,
      sessionUpdate: switchResult,
    };
  }

  // 特殊：切回預設（page 0 / page default / page reset）
  if (arg === 'default' || arg === 'reset' || arg === '0') {
    const switchResult = switchPage(ctx.sessionData, undefined);
    return {
      markdown: 'Switched to default page.',
      sessionUpdate: switchResult,
    };
  }

  // /page N → 數字選擇
  if (/^\d+$/.test(arg)) {
    const idx = parseInt(arg) - 1;
    if (idx >= 0 && idx < files.length) {
      const target = files[idx];
      const switchResult = switchPage(ctx.sessionData, target);
      return {
        markdown: `Switched to: **${target.replace(/\.md$/, '')}**`,
        sessionUpdate: switchResult,
      };
    }
    return { markdown: `Invalid number (1-${files.length}). Use \`/page\` to see list.` };
  }

  // /page X → 模糊比對
  const query = arg.toLowerCase();
  const target = files.find(f => f.toLowerCase().replace(/\.md$/, '').includes(query))
    || files.find(f => f.toLowerCase().includes(query));
  if (!target) {
    return { markdown: `Page not found: ${arg}\nUse \`/page\` to list available pages.` };
  }

  const switchResult = switchPage(ctx.sessionData, target);
  return {
    markdown: `Switched to: **${target.replace(/\.md$/, '')}**`,
    sessionUpdate: switchResult,
  };
}

/** 讀取 .sessions.json（file watcher 的 session mapping） */
function loadFileSessions(promptDir: string): Record<string, SessionData> {
  try {
    const file = join(promptDir, '.sessions.json');
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf-8'));
    }
  } catch {}
  return {};
}

function handleShell(name: string): CommandResult {
  const shell = SHELL_COMMANDS[name];
  if (!shell) return { markdown: `Unknown shell command: ${name}` };
  try {
    const output = execSync(shell, { timeout: 30000, encoding: 'utf-8' }).trim();
    return { markdown: output || '(no output)' };
  } catch (err: any) {
    return { markdown: `Error: ${err.message}` };
  }
}
