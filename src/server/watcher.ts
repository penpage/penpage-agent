import { watch } from 'chokidar';
import { readFileSync, writeFileSync, appendFileSync, truncateSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { runPrompt, compactSession } from './runners/execute.js';
import { parseCommand, executeCommand, SessionData } from './commands.js';
import { formatSessionLine, formatLogLine, formatCompactInfo } from '../shared/formatSession.js';

interface SessionMap {
  [filename: string]: SessionData;
}

const BUILD_TAG = '20260427b'; // 每次修改時更新
const SESSIONS_FILE = '.sessions.json';
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Per-file write tracking (replaces global boolean)
const writingFiles = new Set<string>();

// Processing queue
const queue: string[] = [];
let processing = false;

function loadSessions(promptDir: string): SessionMap {
  const file = join(promptDir, SESSIONS_FILE);
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSessions(promptDir: string, sessions: SessionMap) {
  const file = join(promptDir, SESSIONS_FILE);
  writeFileSync(file, JSON.stringify(sessions, null, 2));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function repairSessions(promptDir: string) {
  console.log('\n  [repair] Starting session repair...');

  const sessionsFile = join(promptDir, SESSIONS_FILE);
  const sessions = loadSessions(promptDir);

  // 1. Backup
  if (existsSync(sessionsFile)) {
    const backupFile = sessionsFile + '.bak';
    writeFileSync(backupFile, readFileSync(sessionsFile));
    console.log('  [repair] Backed up .sessions.json -> .sessions.json.bak');
  }

  // 2. Scan existing .md files
  const mdFiles = new Set(
    readdirSync(promptDir).filter(f => f.endsWith('.md'))
  );

  const removed: string[] = [];
  const deduplicated: string[] = [];
  const invalidIds: string[] = [];
  const emptyRemoved: string[] = [];

  // 3. Remove entries whose .md file doesn't exist
  for (const filename of Object.keys(sessions)) {
    if (!mdFiles.has(filename)) {
      removed.push(filename);
      delete sessions[filename];
    }
  }

  // 4. Deduplicate by sessionId
  const seenIds = new Map<string, string>();
  for (const [filename, data] of Object.entries(sessions)) {
    if (data.sessionId) {
      const existing = seenIds.get(data.sessionId);
      if (existing) {
        deduplicated.push(filename);
        delete sessions[filename];
      } else {
        seenIds.set(data.sessionId, filename);
      }
    }
  }

  // 5. Validate sessionId format
  for (const [filename, data] of Object.entries(sessions)) {
    if (data.sessionId && !UUID_RE.test(data.sessionId)) {
      invalidIds.push(`${filename} (${data.sessionId})`);
      data.sessionId = undefined;
    }
  }

  // 6. Remove empty/useless entries
  for (const [filename, data] of Object.entries(sessions)) {
    if (!data.sessionId && !data.totalCost && !data.totalTurns && !data.messages?.length) {
      emptyRemoved.push(filename);
      delete sessions[filename];
    }
  }

  // 7. Save repaired sessions
  saveSessions(promptDir, sessions);

  // 8. Report
  const total = removed.length + deduplicated.length + invalidIds.length + emptyRemoved.length;
  if (total === 0) {
    console.log('  [repair] No issues found.');
  } else {
    if (removed.length) {
      console.log(`  [repair] Removed (missing .md): ${removed.length}`);
      removed.forEach(f => console.log(`           - ${f}`));
    }
    if (deduplicated.length) {
      console.log(`  [repair] Deduplicated: ${deduplicated.length}`);
      deduplicated.forEach(f => console.log(`           - ${f}`));
    }
    if (invalidIds.length) {
      console.log(`  [repair] Invalid sessionIds fixed: ${invalidIds.length}`);
      invalidIds.forEach(f => console.log(`           - ${f}`));
    }
    if (emptyRemoved.length) {
      console.log(`  [repair] Empty entries removed: ${emptyRemoved.length}`);
      emptyRemoved.forEach(f => console.log(`           - ${f}`));
    }
  }
  console.log('  [repair] Done.\n');
}

function formatTime(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function shortTime(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** mm-dd hh:mm:ss 格式，用於 code block 行首 */
function shortDateTime(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const time = d.toTimeString().slice(0, 8);
  return `${mm}-${dd} ${time}`;
}

const LOG_FILE = '/tmp/penpage-agent.log';

function logRaw(line: string) {
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch { /* ignore */ }
}

function writeFile(filePath: string, content: string) {
  writingFiles.add(filePath);
  writeFileSync(filePath, content);
  setTimeout(() => writingFiles.delete(filePath), 500);
}

/** Append-only 寫入，不修改既有內容 */
function appendToFile(filePath: string, content: string) {
  writingFiles.add(filePath);
  appendFileSync(filePath, content);
  setTimeout(() => writingFiles.delete(filePath), 500);
}

/** 若檔案以 \n```\n 結尾，移除最後的 ```\n 並回傳 true */
function removeClosingFence(filePath: string): boolean {
  const buf = readFileSync(filePath);
  if (buf.length < 5) return false;
  // 檢查尾部 4 bytes 是 ```\n，且前面有 \n
  if (buf[buf.length - 4] === 0x60 && buf[buf.length - 3] === 0x60
    && buf[buf.length - 2] === 0x60 && buf[buf.length - 1] === 0x0a
    && buf[buf.length - 5] === 0x0a) {
    truncateSync(filePath, buf.length - 4); // 移除 ```\n，保留前面的 \n
    return true;
  }
  return false;
}


/** 解析最後一行指令，回傳 lastLine、contentLines、是否有尾部換行 */
function getLastCommand(content: string): { lastLine: string; contentLines: string[]; hasTrailingNewline: boolean } | null {
  const lines = content.split('\n');
  let lastNonEmptyIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') { lastNonEmptyIdx = i; break; }
  }
  if (lastNonEmptyIdx < 0) return null;
  const lastLine = lines[lastNonEmptyIdx].trim();
  if (!lastLine) return null;
  const hasTrailingNewline = lastNonEmptyIdx < lines.length - 1;
  return { lastLine, contentLines: lines.slice(0, lastNonEmptyIdx + 1), hasTrailingNewline };
}

function extractPrompt(content: string): string {
  // Find the last user section (after the last --- separator)
  const sections = content.split(/\n---\n/);
  const lastSection = sections[sections.length - 1];
  // Remove the trigger line (/plan or /run)
  const lines = lastSection.trim().split('\n');
  lines.pop(); // remove /plan or /run
  let text = lines.join('\n').trim();
  // 去掉尾部的 code block（session info）
  text = text.replace(/\n*```\n[\s\S]*?\n```\s*$/, '').trim();
  return text;
}

function processNext(promptDir: string, cwd: string) {
  if (processing || queue.length === 0) return;

  const filePath = queue.shift()!;
  processing = true;

  handleFile(filePath, promptDir, cwd).finally(() => {
    processing = false;
    processNext(promptDir, cwd);
  });
}

function enqueue(filePath: string, promptDir: string, cwd: string) {
  if (queue.includes(filePath)) return;
  queue.push(filePath);
  processNext(promptDir, cwd);
}

async function handleFile(filePath: string, promptDir: string, cwd: string): Promise<void> {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }

  const filename = basename(filePath);

  // 解析最後一行
  const cmd = getLastCommand(content);
  if (!cmd) return;

  const { lastLine, hasTrailingNewline } = cmd;

  // Check for shared commands (/model, /help, /session, etc.)
  const parsed = parseCommand(lastLine);
  if (parsed) {
    // 所有 command 都需要尾部換行確認（與前端 /command\n 偵測一致）
    if (!hasTrailingNewline) return;
    const sessions = loadSessions(promptDir);
    const sessionData = sessions[filename] || {};
    const result = await executeCommand(parsed.name, parsed.args, { cwd, filename, sessionData });
    if (result) {
      // Apply session updates
      if (result.sessionUpdate) {
        sessions[filename] = { ...sessionData, ...result.sessionUpdate };
        saveSessions(promptDir, sessions);
      }
      const merged = { ...sessionData, ...result.sessionUpdate };
      const mergedRunner = merged.runner || 'claude';
      const mergedModelDisplay = merged.model ? `${mergedRunner} - ${merged.model}` : mergedRunner;
      const cmdLine = `/${parsed.name}${parsed.args.length ? ' ' + parsed.args.join(' ') : ''}`;
      const ts = shortDateTime();

      // /compact → 送 '/compact' 給 CLI
      if (result.action === 'compact' && merged.sessionId) {
        logRaw(formatLogLine({ source: 'agent', filename, model: mergedModelDisplay, sessionId: merged.sessionId, command: '/compact' }));
        appendToFile(filePath, `\n\n\`\`\`\n${ts} ⏳compact...\n\`\`\`\n`);
        try {
          const compactResult = await compactSession(merged.sessionId, cwd);
          const endTs = shortDateTime();
          const cr = compactResult.result;
          const compactInfo = cr ? ` ${formatCompactInfo({
            afterCtxUsed: cr.contextUsed, afterCtxWindow: cr.contextWindow,
            afterCacheRead: cr.cacheRead, afterInputTokens: cr.inputTokens, afterOutputTokens: cr.outputTokens,
          })}` : '';
          writingFiles.add(filePath);
          appendFileSync(filePath, `\n\`\`\`\n${endTs} ✅compact${compactInfo}\n\`\`\`\n\n---\n`);
          setTimeout(() => writingFiles.delete(filePath), 500);
          logRaw(formatLogLine({ source: 'agent', filename, model: mergedModelDisplay, sessionId: merged.sessionId, status: `compacted${compactInfo}` }));
        } catch {
          appendToFile(filePath, `\n\`\`\`\n❌compact failed\n\`\`\`\n\n---\n`);
          logRaw(formatLogLine({ source: 'agent', filename, model: mergedModelDisplay, sessionId: merged.sessionId, status: 'compact-err' }));
        }
        return;
      }

      const info = formatSessionLine({
        model: mergedModelDisplay,
        session: merged.sessionId,
        turns: merged.totalTurns,
        totalCost: merged.totalCost,
        completed: formatTime(),
      });
      // Append-only：只追加，不修改既有內容
      const cmdSid = merged.sessionId ? merged.sessionId.slice(0, 7) : '';
      const appendContent = `\n\n\`\`\`\n${ts} ✳️${cmdSid} ${cmdLine}\n\`\`\`\n\n${result.markdown}\n\n\`\`\`\n${ts} ✅${info}\n\`\`\`\n\n---\n`;
      logRaw(formatLogLine({ source: 'agent', filename, model: mergedModelDisplay, sessionId: merged.sessionId, command: cmdLine }));
      appendToFile(filePath, appendContent);
      logRaw(formatLogLine({ source: 'agent', filename, model: mergedModelDisplay, sessionId: merged.sessionId, status: 'ok', totalCost: merged.totalCost, turns: merged.totalTurns }));
      return;
    }
  }

  // /plan 和 /run 是觸發器，需要尾部換行確認（與前端一致）
  if (lastLine !== '/plan' && lastLine !== '/run') return;
  if (!hasTrailingNewline) return;

  const mode = lastLine === '/plan' ? 'plan' : 'auto';
  const cmdLabel = mode === 'plan' ? '/plan' : '/run';

  // Load session mapping
  const sessions = loadSessions(promptDir);
  const sessionId = sessions[filename]?.sessionId;
  const selectedRunner = sessions[filename]?.runner || 'claude';
  const selectedModel = sessions[filename]?.model;
  const addDirs = sessions[filename]?.addDirs;

  // Extract prompt 在 append 之前（使用原始 content）
  const prompt = extractPrompt(content);
  if (!prompt) return;

  // Append-only：追加 command code block，不修改既有內容
  const startTime = formatTime();
  const startTs = shortDateTime();
  const modelDisplay = selectedModel ? `${selectedRunner} - ${selectedModel}` : selectedRunner;
  const sidTag = sessionId ? `${sessionId.slice(0, 7)} ` : '';
  appendToFile(filePath, `\n\n\`\`\`\n${startTs} ✳️${sidTag}${cmdLabel}\n\`\`\`\n`);

  logRaw(formatLogLine({ source: 'agent', filename, model: modelDisplay, sessionId, command: cmdLabel, promptPreview: prompt }));

  try {
    const { child, done } = runPrompt(selectedRunner, prompt, cwd, {
      sessionId,
      permissionMode: mode === 'plan' ? 'plan' : 'auto',
      model: selectedModel || undefined,
      addDirs: addDirs?.length ? addDirs : undefined,
    });

    // Timeout
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, TIMEOUT_MS);

    const runResult = await done;
    clearTimeout(timer);

    if (runResult.exitCode !== 0 && !runResult.text) {
      // Error: 獨立 code block
      const errTs = shortDateTime();
      writingFiles.add(filePath);
      appendFileSync(filePath, `\n\n\`\`\`\n${errTs} ❌error: exit code ${runResult.exitCode}\n\`\`\`\n\n---\n`);
      setTimeout(() => writingFiles.delete(filePath), 500);
      logRaw(formatLogLine({ source: 'agent', filename, model: modelDisplay, sessionId, status: `err:${runResult.exitCode}` }));
      return;
    }

    // Save session mapping + cost
    const prev = sessions[filename] || {};
    const newSessionId = runResult.result?.sessionId || runResult.session?.id;
    const resultCost = runResult.result?.cost || 0;
    const resultTurns = runResult.result?.turns || 0;
    const updated_session = {
      ...prev,
      ...(newSessionId ? { sessionId: newSessionId } : {}),
      totalCost: (prev.totalCost || 0) + resultCost,
      totalTurns: (prev.totalTurns || 0) + resultTurns,
      totalInputTokens: (prev.totalInputTokens || 0) + (runResult.result?.inputTokens || 0),
      totalOutputTokens: (prev.totalOutputTokens || 0) + (runResult.result?.outputTokens || 0),
    };
    sessions[filename] = updated_session;
    saveSessions(promptDir, sessions);

    // Append result code block + AI response + separator
    const endTime = formatTime();
    const endTs = shortDateTime();
    const actualModel = runResult.session?.model || modelDisplay;
    const finishInfo = formatSessionLine({
      model: actualModel,
      session: newSessionId || sessionId,
      turns: updated_session.totalTurns,
      runCost: resultCost,
      totalCost: updated_session.totalCost,
      inputTokens: runResult.result?.inputTokens,
      outputTokens: runResult.result?.outputTokens,
      cacheRead: runResult.result?.cacheRead,
      cacheCreation: runResult.result?.cacheCreation,
      contextUsed: runResult.result?.contextUsed,
      contextWindow: runResult.result?.contextWindow,
      started: startTime,
      completed: endTime,
    });

    const response = runResult.text.trim() || '*No response.*';
    writingFiles.add(filePath);
    appendFileSync(filePath, `\n${response}\n\n\`\`\`\n${endTs} ✅${finishInfo}\n\`\`\`\n\n---\n`);
    setTimeout(() => writingFiles.delete(filePath), 500);
    const respLines = response.split('\n').length;
    const durationSec = Math.round((new Date(endTime.replace(' ', 'T')).getTime() - new Date(startTime.replace(' ', 'T')).getTime()) / 1000);
    logRaw(formatLogLine({
      source: 'agent', filename, model: actualModel, sessionId: newSessionId || sessionId,
      status: 'ok', lines: respLines, runCost: resultCost, totalCost: updated_session.totalCost,
      turns: updated_session.totalTurns, inputTokens: runResult.result?.inputTokens,
      outputTokens: runResult.result?.outputTokens,
      contextUsed: runResult.result?.contextUsed, contextWindow: runResult.result?.contextWindow,
      durationSec,
    }));

    // Auto compact：context > 70% 時自動壓縮
    const finalSid = newSessionId || sessionId;
    const rr = runResult.result;
    if (finalSid && rr?.contextUsed && rr?.contextWindow) {
      const pct = (rr.contextUsed / rr.contextWindow) * 100;
      if (pct > 70) {
        logRaw(formatLogLine({ source: 'agent', filename, model: actualModel, sessionId: finalSid, command: `auto-compact (ctx ${pct.toFixed(0)}%)` }));
        try {
          const compactResult = await compactSession(finalSid, cwd);
          const cr = compactResult.result;
          const compactInfo = formatCompactInfo({
            beforeCtxUsed: rr.contextUsed, beforeCtxWindow: rr.contextWindow,
            beforeCacheRead: rr.cacheRead, beforeInputTokens: rr.inputTokens, beforeOutputTokens: rr.outputTokens,
            afterCtxUsed: cr?.contextUsed, afterCtxWindow: cr?.contextWindow,
            afterCacheRead: cr?.cacheRead, afterInputTokens: cr?.inputTokens, afterOutputTokens: cr?.outputTokens,
          });
          const acTs = shortDateTime();
          writingFiles.add(filePath);
          appendFileSync(filePath, `\n\`\`\`\n${acTs} ✅auto-compact ${compactInfo}\n\`\`\`\n`);
          setTimeout(() => writingFiles.delete(filePath), 500);
          logRaw(formatLogLine({ source: 'agent', filename, model: actualModel, sessionId: finalSid, status: `auto-compacted ${compactInfo}` }));
        } catch {
          logRaw(formatLogLine({ source: 'agent', filename, model: actualModel, sessionId: finalSid, status: 'auto-compact-err' }));
        }
      }
    }
  } catch (err: any) {
    appendToFile(filePath, `\n\n*Error: ${err.message}*\n\n---\n`);
    logRaw(formatLogLine({ source: 'agent', filename, model: modelDisplay, sessionId, status: `err:${err.message}` }));
  }
}

function scanPendingFiles(promptDir: string, cwd: string) {
  try {
    const files = readdirSync(promptDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const filePath = join(promptDir, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const cmd = getLastCommand(content);
        if (!cmd) continue;
        const { lastLine, hasTrailingNewline } = cmd;
        const parsed = parseCommand(lastLine);
        const canExecute = hasTrailingNewline
          && (parsed || lastLine === '/plan' || lastLine === '/run');
        if (canExecute) {
          logRaw(formatLogLine({ source: 'agent', filename: file, command: `pending: ${lastLine}` }));
          enqueue(filePath, promptDir, cwd);
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory might not exist yet
  }
}

function cleanupStuckFiles(_promptDir: string) {
  // Append-only 模式不需要清理 stuck 狀態
  // 舊的 /thinking... /running... 不再使用
}

export function startWatcher(cwd: string, repair = false) {
  const promptDir = join(cwd, '.penpage');

  // Ensure directory exists
  if (!existsSync(promptDir)) {
    mkdirSync(promptDir, { recursive: true });
  }

  // Create .gitignore to prevent committing prompt files
  const gitignorePath = join(promptDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, '*\n');
  }

  // Repair sessions if requested
  if (repair) {
    repairSessions(promptDir);
  }

  // Clean up any stuck files from previous runs
  cleanupStuckFiles(promptDir);

  // Scan existing files for pending commands/triggers
  scanPendingFiles(promptDir, cwd);

  const watcher = watch(promptDir, {
    ignoreInitial: true,
    usePolling: true,
    interval: 1000,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
  });

  const onFileChange = (filePath: string) => {
    if (writingFiles.has(filePath)) return;
    if (!filePath.endsWith('.md')) return;
    enqueue(filePath, promptDir, cwd);
  };

  watcher.on('change', onFileChange);
  watcher.on('add', onFileChange);

  const startMsg = `  ${shortTime()}  Watcher started [${BUILD_TAG}]`;
  const logMsg = `  ${shortTime()}  Log: ${LOG_FILE}`;
  console.log(startMsg);
  console.log(logMsg);
  try { appendFileSync(LOG_FILE, '\n' + startMsg + '\n'); } catch { /* ignore */ }

  return watcher;
}
