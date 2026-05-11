/** 共用 session info 格式化（純文字單行，server code block + client session bar 共用） */
export interface SessionDisplayData {
  model?: string;
  session?: string;
  turns?: number;
  totalCost?: number;
  runCost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
  contextUsed?: number;
  contextWindow?: number;
  started?: string;
  completed?: string;
  durationSec?: number;
}

export function formatSessionLine(data: SessionDisplayData): string {
  const parts: string[] = [];

  // session ID 前 7 碼
  if (data.session) parts.push(data.session.slice(0, 7));

  // turns
  parts.push(`${data.turns || 0}t`);

  // context %
  if (data.contextUsed && data.contextWindow) {
    const pct = Math.round((data.contextUsed / data.contextWindow) * 100);
    parts.push(`${pct}%`);
  }

  // cost: $run/$total
  const rc = data.runCost || 0;
  const tc = data.totalCost || 0;
  parts.push(`${fmtCost(rc)}/${fmtCost(tc)}`);

  // duration
  let dur = data.durationSec;
  if (dur === undefined && data.started && data.completed) {
    const s = new Date(data.started.replace(' ', 'T')).getTime();
    const e = new Date(data.completed.replace(' ', 'T')).getTime();
    dur = Math.round((e - s) / 1000);
  }
  if (dur !== undefined && dur > 0) parts.push(fmtDuration(dur));

  // cio: (cr+cc+i+o)/ctx
  if (data.contextWindow && (data.inputTokens || data.outputTokens || data.cacheRead || data.cacheCreation)) {
    const cr = fmtTokens(data.cacheRead || 0);
    const cc = fmtTokens(data.cacheCreation || 0);
    const i = fmtTokens(data.inputTokens || 0);
    const o = fmtTokens(data.outputTokens || 0);
    parts.push(`cio:(${cr}+${cc}+${i}+${o})/${fmtTokens(data.contextWindow)}`);
  }

  // model 放最後
  parts.push(data.model || 'claude');

  return parts.join(' ');
}

/** Compact 前後比較資訊 */
export interface CompactDisplayData {
  beforeCtxUsed?: number;
  beforeCtxWindow?: number;
  beforeCacheRead?: number;
  beforeInputTokens?: number;
  beforeOutputTokens?: number;
  afterCtxUsed?: number;
  afterCtxWindow?: number;
  afterCacheRead?: number;
  afterInputTokens?: number;
  afterOutputTokens?: number;
}

/** 格式化 compact 結果：ctx:316%→44% cio:335k 2k 4k→55k 1k 2k */
export function formatCompactInfo(data: CompactDisplayData): string {
  const parts: string[] = [];

  // ctx% before→after
  const bw = data.beforeCtxWindow || data.afterCtxWindow || 0;
  const aw = data.afterCtxWindow || bw;
  if (data.beforeCtxUsed && bw && data.afterCtxUsed && aw) {
    const bp = Math.round((data.beforeCtxUsed / bw) * 100);
    const ap = Math.round((data.afterCtxUsed / aw) * 100);
    parts.push(`ctx:${bp}%→${ap}%`);
  } else if (data.afterCtxUsed && aw) {
    const ap = Math.round((data.afterCtxUsed / aw) * 100);
    parts.push(`ctx:${ap}%`);
  }

  // cio before→after
  const hasBefore = data.beforeCacheRead || data.beforeInputTokens || data.beforeOutputTokens;
  const hasAfter = data.afterCacheRead || data.afterInputTokens || data.afterOutputTokens;
  if (hasBefore && hasAfter) {
    const bc = fmtTokens(data.beforeCacheRead || 0);
    const bi = fmtTokens(data.beforeInputTokens || 0);
    const bo = fmtTokens(data.beforeOutputTokens || 0);
    const ac = fmtTokens(data.afterCacheRead || 0);
    const ai = fmtTokens(data.afterInputTokens || 0);
    const ao = fmtTokens(data.afterOutputTokens || 0);
    parts.push(`cio:${bc} ${bi} ${bo}→${ac} ${ai} ${ao}`);
  } else if (hasAfter) {
    const ac = fmtTokens(data.afterCacheRead || 0);
    const ai = fmtTokens(data.afterInputTokens || 0);
    const ao = fmtTokens(data.afterOutputTokens || 0);
    parts.push(`cio:${ac} ${ai} ${ao}`);
  }

  return parts.join(' ');
}

/** 時間距離格式化：timestamp → "2m ago", "3h ago", "1d ago" */
export function timeAgo(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// --- 統一 console log 格式 ---

function shortDateTime(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const time = d.toTimeString().slice(0, 8);
  return `${mm}-${dd} ${time}`;
}

/** 格式化 token 數字：>=1000 顯示 k，<1000 顯示原數 */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
}

/** 格式化 cost：>= $1 顯示 2 位小數，< $1 顯示 4 位小數去尾零 */
function fmtCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  const s = `$${n.toFixed(4)}`;
  return s.replace(/0+$/, '').replace(/\.$/, '.0');
}

/** 格式化秒數：< 60 顯示 5s，>= 60 顯示 1:32s */
function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}s`;
}

/** Model tag：從 model 字串取出簡短名（opus/sonnet/haiku/gemini/codex），無法辨識則用原值 */
function modelTag(model?: string): string {
  if (!model) return 'claude';
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('gemini')) return 'gemini';
  if (lower.includes('codex')) return 'codex';
  // 「claude - sonnet」格式：取 dash 後面
  if (lower.includes(' - ')) return lower.split(' - ').pop()!.trim();
  return model;
}

/** Session ID 前 3 碼，無 session 回傳 'new' */
function sidTag(sessionId?: string): string {
  return sessionId ? sessionId.slice(0, 3) : 'new';
}

/** Chat label for bot logs: chat:[private]:12345 或 chat:[群組名稱]:-5171 */
export function chatLabel(chat: { id: number; type: string; title?: string }): string {
  const idPrefix = String(chat.id).slice(0, 5);
  if (chat.type === 'private') return `chat:[private]:${idPrefix}`;
  const title = chat.title || 'unknown';
  return `chat:[${title}]:${idPrefix}`;
}

export interface LogLineData {
  source: 'agent' | 'bot';
  filename: string;
  model?: string;
  sessionId?: string;
  chat?: { id: number; type: string; title?: string };
  // → 行
  command?: string;       // '/plan' | '/run' | '/model opus' etc.
  promptPreview?: string; // prompt 前幾個字
  // ← 行
  status?: 'ok' | string; // 'ok' 或 error 描述
  lines?: number;         // response 行數（agent only）
  runCost?: number;
  totalCost?: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextUsed?: number;
  contextWindow?: number;
  durationSec?: number;
}

/** 產生統一格式的 console log 行（→ 或 ←） */
export function formatLogLine(data: LogLineData): string {
  const ts = shortDateTime();
  const src = data.source;
  const file = `[${data.filename}]`;
  const model = `${modelTag(data.model)}:${sidTag(data.sessionId)}`;
  const chatPart = data.chat ? ` ${chatLabel(data.chat)}` : '';

  // → 行
  if (data.command !== undefined) {
    const preview = data.promptPreview
      ? ` ${data.promptPreview.slice(0, 50).replace(/\n/g, ' ')}`
      : '';
    return `${ts} ${src}:${file}${chatPart} ${model} → ${data.command}${preview}`;
  }

  // ← 行
  const status = data.status || 'ok';
  const parts: string[] = [];

  // ok 或 error（+ 行數）
  if (status === 'ok' && data.lines) {
    parts.push(`${status} ${data.lines}L`);
  } else {
    parts.push(status);
  }

  // cost: $run/$total
  if (data.runCost !== undefined && data.totalCost !== undefined) {
    parts.push(`${fmtCost(data.runCost)}/${fmtCost(data.totalCost)}`);
  }

  // Nturn
  if (data.turns !== undefined) {
    parts.push(`${data.turns}turn`);
  }

  // io:in/out
  if (data.inputTokens !== undefined || data.outputTokens !== undefined) {
    parts.push(`io:${fmtTokens(data.inputTokens || 0)}/${fmtTokens(data.outputTokens || 0)}`);
  }

  // ctx:N%
  if (data.contextUsed && data.contextWindow) {
    const pct = Math.round((data.contextUsed / data.contextWindow) * 100);
    parts.push(`ctx:${pct}%`);
  }

  // duration m:ss
  if (data.durationSec !== undefined && data.durationSec > 0) {
    parts.push(fmtDuration(data.durationSec));
  }

  return `${ts} ${src}:${file}${chatPart} ${model} ← ${parts.join(' ')}`;
}
