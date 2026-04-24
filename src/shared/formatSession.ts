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
  started?: string;
  completed?: string;
}

export function formatSessionLine(data: SessionDisplayData): string {
  const parts: string[] = [];
  if (data.session) parts.push(data.session.slice(0, 8));
  parts.push(data.model || 'claude');
  const t = data.turns || 0;
  parts.push(`${t} ${t === 1 ? 'turn' : 'turns'}`);
  if (data.runCost !== undefined) parts.push(`$${data.runCost.toFixed(4)}`);
  parts.push(`total:$${(data.totalCost || 0).toFixed(4)}`);
  if (data.inputTokens || data.outputTokens) {
    const inK = ((data.inputTokens || 0) / 1000).toFixed(1);
    const outK = ((data.outputTokens || 0) / 1000).toFixed(1);
    const tokenParts = [`in:${inK}k`, `out:${outK}k`];
    if (data.cacheRead) tokenParts.push(`cache:${(data.cacheRead / 1000).toFixed(1)}k`);
    parts.push(tokenParts.join(' '));
  }
  if (data.completed) {
    let timeStr = data.completed.slice(11);
    if (data.started) {
      const s = new Date(data.started.replace(' ', 'T')).getTime();
      const e = new Date(data.completed.replace(' ', 'T')).getTime();
      const sec = Math.round((e - s) / 1000);
      if (sec >= 60) {
        const m = Math.floor(sec / 60);
        const r = sec % 60;
        timeStr += r > 0 ? ` (${m}m ${r}s)` : ` (${m}m)`;
      } else if (sec > 0) {
        timeStr += ` (${sec}s)`;
      }
    }
    parts.push(timeStr);
  } else if (data.started) {
    parts.push(data.started.slice(11));
  }
  return parts.join('  ');
}
