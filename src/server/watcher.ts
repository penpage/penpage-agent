import { watch } from 'chokidar';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { getRunner } from './runners/index.js';

interface SessionMap {
  [filename: string]: string;
}

const SESSIONS_FILE = '.sessions.json';
let selfWriting = false;

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

function extractPrompt(content: string): string {
  // Find the last user section (after the last --- separator)
  const sections = content.split(/\n---\n/);
  const lastSection = sections[sections.length - 1];
  // Remove the trigger line (/plan or /run)
  const lines = lastSection.trim().split('\n');
  lines.pop(); // remove /plan or /run
  return lines.join('\n').trim();
}

async function handleFile(filePath: string, promptDir: string, cwd: string) {
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
  selfWriting = true;
  writeFileSync(filePath, lines.join('\n') + '\n');
  selfWriting = false;

  // Load session mapping
  const sessions = loadSessions(promptDir);
  const sessionId = sessions[filename];

  // Extract only the latest user prompt
  const prompt = extractPrompt(content);
  if (!prompt) {
    selfWriting = true;
    writeFileSync(filePath, content.replace(statusLine, '/done (empty prompt)'));
    selfWriting = false;
    return;
  }

  console.log(`  [watcher] ${filename}: ${mode} mode, prompt: ${prompt.slice(0, 80)}...`);

  const runner = getRunner('claude');
  if (!runner) {
    console.log('  [watcher] Claude runner not found');
    return;
  }

  const permissionMode = mode === 'plan' ? 'plan' : undefined;
  const child = runner.run(prompt, cwd, {
    sessionId,
    permissionMode: permissionMode as 'plan' | undefined,
  });

  let responseText = '';
  let newSessionId = '';
  let stdoutBuffer = '';

  child.stdout!.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    const jsonLines = stdoutBuffer.split('\n');
    stdoutBuffer = jsonLines.pop() || '';

    for (const line of jsonLines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        // Capture session ID from init event
        if (event.type === 'system' && event.subtype === 'init') {
          newSessionId = event.session_id || '';
          continue;
        }

        // Capture text from assistant message
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              responseText += block.text;
            }
          }
          continue;
        }

        // Capture session ID from result
        if (event.type === 'result' && event.session_id) {
          newSessionId = event.session_id;
        }
      } catch {
        // Skip malformed JSON
      }
    }
  });

  child.on('close', () => {
    // Save session mapping
    if (newSessionId) {
      sessions[filename] = newSessionId;
      saveSessions(promptDir, sessions);
    }

    // Append response to file
    const currentContent = readFileSync(filePath, 'utf-8');
    const updated = currentContent.replace(
      statusLine,
      '/done'
    );

    const output = responseText.trim()
      ? `${updated}\n---\n\n**Claude (${mode}):**\n\n${responseText.trim()}\n`
      : `${updated}\n---\n\n*No response.*\n`;

    selfWriting = true;
    writeFileSync(filePath, output);
    selfWriting = false;

    console.log(`  [watcher] ${filename}: done, ${responseText.length} chars`);
  });
}

export function startWatcher(cwd: string) {
  const promptDir = join(cwd, '.claude', 'prompt');

  // Ensure directory exists
  if (!existsSync(promptDir)) {
    mkdirSync(promptDir, { recursive: true });
  }

  const watcher = watch(promptDir, {
    ignoreInitial: true,
    usePolling: true,
    interval: 1000,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });


  const onFileChange = (filePath: string) => {
    if (selfWriting) return;
    if (!filePath.endsWith('.md')) return;
    handleFile(filePath, promptDir, cwd);
  };

  watcher.on('change', onFileChange);
  watcher.on('add', onFileChange);

  console.log(`  Watcher: ${promptDir}`);

  return watcher;
}
