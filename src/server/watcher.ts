import { watch } from 'chokidar';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { getRunner } from './runners/index.js';
import { parseCommand, executeCommand, SessionData } from './commands.js';
import { formatSessionLine } from '../shared/formatSession.js';

interface SessionMap {
  [filename: string]: SessionData;
}

const BUILD_TAG = '20260424f'; // 每次修改時更新
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

function formatTime(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function shortTime(): string {
  return new Date().toTimeString().slice(0, 8);
}

function log(file: string, arrow: string, msg: string) {
  console.log(`  ${shortTime()}  ${file} ${arrow} ${msg}`);
}

function writeFile(filePath: string, content: string) {
  writingFiles.add(filePath);
  writeFileSync(filePath, content);
  setTimeout(() => writingFiles.delete(filePath), 500);
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

  const { lastLine, contentLines, hasTrailingNewline } = cmd;

  // Check for shared commands (/model, /help, /resume, etc.)
  const parsed = parseCommand(lastLine);
  if (parsed) {
    // 有參數的 command 需要尾部換行確認（避免 auto-save 截斷參數）
    if (parsed.args.length > 0 && !hasTrailingNewline) return;
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
      const info = formatSessionLine({
        model: mergedModelDisplay,
        session: merged.sessionId,
        turns: merged.totalTurns,
        totalCost: merged.totalCost,
        completed: formatTime(),
      });
      contentLines.pop(); // 移除 command 行
      const cmdOutput = contentLines.join('\n') + `\n\n\`\`\`\n${cmdLine}\n${info}\n\`\`\`\n\n${result.markdown}\n\n---\n`;
      log(filename, '→', cmdLine);
      writeFile(filePath, cmdOutput);
      log(filename, '←', `${cmdOutput.split('\n').length} lines, ok`);
      return;
    }
  }

  // /plan 和 /run 是觸發器，無參數，不需要尾部換行
  if (lastLine !== '/plan' && lastLine !== '/run') return;

  const mode = lastLine === '/plan' ? 'plan' : 'auto';
  const statusLine = mode === 'plan' ? '/thinking...' : '/running...';

  // Load session mapping
  const sessions = loadSessions(promptDir);
  const sessionId = sessions[filename]?.sessionId;
  const selectedRunner = sessions[filename]?.runner || 'claude';
  const selectedModel = sessions[filename]?.model;
  const addDirs = sessions[filename]?.addDirs;

  // Replace trigger line with status + code block
  const startTime = formatTime();
  const modelDisplay = selectedModel ? `${selectedRunner} - ${selectedModel}` : selectedRunner;
  const startInfo = formatSessionLine({
    model: modelDisplay,
    session: sessionId,
    started: startTime,
  });
  contentLines[contentLines.length - 1] = statusLine;
  writeFile(filePath, contentLines.join('\n') + `\n\n\`\`\`\n${startInfo}\n\`\`\`\n`);

  // Extract only the latest user prompt
  const prompt = extractPrompt(content);
  if (!prompt) {
    contentLines.pop(); // 移除 status line
    writeFile(filePath, contentLines.join('\n') + '\n');
    return;
  }

  log(filename, '→', `/${mode === 'plan' ? 'plan' : 'run'} ${prompt.slice(0, 60)}...`);

  const runner = getRunner(selectedRunner);
  if (!runner) {
    contentLines[contentLines.length - 1] = '/error (no runner)';
    writeFile(filePath, contentLines.join('\n') + '\n');
    log(filename, '←', `error: runner "${selectedRunner}" not found`);
    return;
  }

  const permissionMode = mode === 'plan' ? 'plan' : undefined;
  const child = runner.run(prompt, cwd, {
    sessionId,
    permissionMode: permissionMode as 'plan' | undefined,
    model: selectedModel || undefined,
    addDirs: addDirs?.length ? addDirs : undefined,
  });

  return new Promise<void>((resolve) => {
    let responseText = '';
    let newSessionId = '';
    let actualModel = '';
    let stdoutBuffer = '';
    let finished = false;
    let resultCost = 0;
    let resultInputTokens = 0;
    let resultOutputTokens = 0;
    let resultTurns = 0;
    let resultCacheRead = 0;

    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (error) {
        const currentContent = readFileSync(filePath, 'utf-8');
        writeFile(filePath, currentContent.replace(statusLine, `/error (${error})`));
        log(filename, '←', `error: ${error}`);
        resolve();
        return;
      }

      // Save session mapping + cost
      const prev = sessions[filename] || {};
      const updated_session = {
        ...prev,
        ...(newSessionId ? { sessionId: newSessionId } : {}),
        totalCost: (prev.totalCost || 0) + resultCost,
        totalTurns: (prev.totalTurns || 0) + resultTurns,
        totalInputTokens: (prev.totalInputTokens || 0) + resultInputTokens,
        totalOutputTokens: (prev.totalOutputTokens || 0) + resultOutputTokens,
      };
      sessions[filename] = updated_session;
      saveSessions(promptDir, sessions);

      // 用完整 session info 替換 code block，移除 status line
      const currentContent = readFileSync(filePath, 'utf-8');
      const endTime = formatTime();
      const finishInfo = formatSessionLine({
        model: actualModel || modelDisplay,
        session: newSessionId || sessionId,
        turns: updated_session.totalTurns,
        runCost: resultCost,
        totalCost: updated_session.totalCost,
        inputTokens: resultInputTokens,
        outputTokens: resultOutputTokens,
        cacheRead: resultCacheRead,
        started: startTime,
        completed: endTime,
      });
      // 移除 status line（/thinking... 或 /running...）並替換 code block
      let updated = currentContent.replace(statusLine + '\n', '');
      updated = updated.replace(/```\n[\s\S]*?\n```/, `\`\`\`\n${finishInfo}\n\`\`\``);

      const output = responseText.trim()
        ? `${updated}\n\n${responseText.trim()}\n\n---\n`
        : `${updated}\n\n*No response.*\n\n---\n`;

      writeFile(filePath, output);
      log(filename, '←', `${output.split('\n').length} lines, ok`);
      resolve();
    };

    // Timeout
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish('timeout');
    }, TIMEOUT_MS);

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const jsonLines = stdoutBuffer.split('\n');
      stdoutBuffer = jsonLines.pop() || '';

      for (const line of jsonLines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          if (event.type === 'system' && event.subtype === 'init') {
            newSessionId = event.session_id || '';
            if (event.model) actualModel = event.model;
            continue;
          }

          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text') {
                responseText += block.text;
              }
            }
            continue;
          }

          if (event.type === 'result') {
            if (event.session_id) newSessionId = event.session_id;
            if (event.total_cost_usd) resultCost = event.total_cost_usd;
            if (event.num_turns) resultTurns = event.num_turns;
            if (event.usage) {
              resultInputTokens = event.usage.input_tokens || 0;
              resultOutputTokens = event.usage.output_tokens || 0;
              resultCacheRead = event.usage.cache_read_input_tokens || 0;
            }
          }
        } catch {
          // Skip malformed JSON
        }
      }
    });

    child.on('close', (code) => {
      if (code !== 0 && !responseText) {
        finish(`exit code ${code}`);
      } else {
        finish();
      }
    });

    child.on('error', (err) => {
      finish(err.message);
    });
  });
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
        const canExecute = (parsed && (parsed.args.length === 0 || hasTrailingNewline))
          || lastLine === '/plan' || lastLine === '/run';
        if (canExecute) {
          log(file, '→', `pending: ${lastLine}`);
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

function cleanupStuckFiles(promptDir: string) {
  try {
    const files = readdirSync(promptDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const filePath = join(promptDir, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        // 偵測 stuck 狀態（不需要尾部換行確認）
        if (content.includes('/thinking...') || content.includes('/running...')) {
          const updated = content
            .replace('/thinking...', '/error (interrupted)')
            .replace('/running...', '/error (interrupted)');
          writeFileSync(filePath, updated);
          log(file, '←', 'cleanup: interrupted');
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory might not exist yet
  }
}

export function startWatcher(cwd: string) {
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

  console.log(`  Watcher: ${promptDir} [${BUILD_TAG}]`);

  return watcher;
}
