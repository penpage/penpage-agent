import { watch } from 'chokidar';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { getRunner } from './runners/index.js';

interface SessionMap {
  [filename: string]: string;
}

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

function writeFile(filePath: string, content: string) {
  writingFiles.add(filePath);
  writeFileSync(filePath, content);
  // Keep in set briefly to cover async event delivery
  setTimeout(() => writingFiles.delete(filePath), 500);
}

function extractPrompt(content: string): string {
  // Find the last user section (after the last --- separator)
  const sections = content.split(/\n---\n/);
  const lastSection = sections[sections.length - 1];
  // Remove the trigger line (/plan or /run)
  const lines = lastSection.trim().split('\n');
  lines.pop(); // remove /plan or /run
  return lines.join('\n').trim();
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
  // Don't add duplicates
  if (!queue.includes(filePath)) {
    queue.push(filePath);
  }
  processNext(promptDir, cwd);
}

async function handleFile(filePath: string, promptDir: string, cwd: string): Promise<void> {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }

  const lines = content.trimEnd().split('\n');
  const lastLine = lines[lines.length - 1]?.trim();

  if (lastLine !== '/plan' && lastLine !== '/run') return;

  const mode = lastLine === '/plan' ? 'plan' : 'auto';
  const statusLine = mode === 'plan' ? '/thinking...' : '/running...';
  const filename = basename(filePath);

  // Replace trigger line with status
  lines[lines.length - 1] = statusLine;
  writeFile(filePath, lines.join('\n') + '\n');

  // Load session mapping
  const sessions = loadSessions(promptDir);
  const sessionId = sessions[filename];

  // Extract only the latest user prompt
  const prompt = extractPrompt(content);
  if (!prompt) {
    writeFile(filePath, content.replace(lastLine, '/done (empty prompt)'));
    return;
  }

  console.log(`  [watcher] ${filename}: ${mode} mode, prompt: ${prompt.slice(0, 80)}...`);

  const runner = getRunner('claude');
  if (!runner) {
    console.log('  [watcher] Claude runner not found');
    writeFile(filePath, content.replace(lastLine, '/error (no runner)'));
    return;
  }

  const permissionMode = mode === 'plan' ? 'plan' : undefined;
  const child = runner.run(prompt, cwd, {
    sessionId,
    permissionMode: permissionMode as 'plan' | undefined,
  });

  return new Promise<void>((resolve) => {
    let responseText = '';
    let newSessionId = '';
    let stdoutBuffer = '';
    let finished = false;

    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (error) {
        const currentContent = readFileSync(filePath, 'utf-8');
        writeFile(filePath, currentContent.replace(statusLine, `/error (${error})`));
        console.log(`  [watcher] ${filename}: error — ${error}`);
        resolve();
        return;
      }

      // Save session mapping
      if (newSessionId) {
        sessions[filename] = newSessionId;
        saveSessions(promptDir, sessions);
      }

      // Append response to file
      const currentContent = readFileSync(filePath, 'utf-8');
      const updated = currentContent.replace(statusLine, '/done');

      const output = responseText.trim()
        ? `${updated}\n---\n\n**Claude (${mode}):**\n\n${responseText.trim()}\n`
        : `${updated}\n---\n\n*No response.*\n`;

      writeFile(filePath, output);
      console.log(`  [watcher] ${filename}: done, ${responseText.length} chars`);
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

          if (event.type === 'result' && event.session_id) {
            newSessionId = event.session_id;
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

function cleanupStuckFiles(promptDir: string) {
  try {
    const files = readdirSync(promptDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const filePath = join(promptDir, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lastLine = content.trimEnd().split('\n').pop()?.trim();
        if (lastLine === '/thinking...' || lastLine === '/running...') {
          const updated = content.replace(lastLine, '/error (interrupted)');
          writeFileSync(filePath, updated);
          console.log(`  [watcher] Cleaned up stuck file: ${file}`);
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
  const promptDir = join(cwd, '.claude', 'prompt');

  // Ensure directory exists
  if (!existsSync(promptDir)) {
    mkdirSync(promptDir, { recursive: true });
  }

  // Clean up any stuck files from previous runs
  cleanupStuckFiles(promptDir);

  const watcher = watch(promptDir, {
    ignoreInitial: true,
    usePolling: true,
    interval: 1000,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  const onFileChange = (filePath: string) => {
    if (writingFiles.has(filePath)) return;
    if (!filePath.endsWith('.md')) return;
    enqueue(filePath, promptDir, cwd);
  };

  watcher.on('change', onFileChange);
  watcher.on('add', onFileChange);

  console.log(`  Watcher: ${promptDir}`);

  return watcher;
}
