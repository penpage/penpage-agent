#!/usr/bin/env node

import 'dotenv/config';
import { createServer } from '../server/index.js';
import { startTelegramBot } from '../telegram/bot.js';
import { parseCommand, executeCommand } from '../server/commands.js';
import { startMcpServer } from '../mcp/server.js';
import { ensureMcpConfig } from '../lib/setupMcp.js';
import open from 'open';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function parseArgs() {
  let port = 3456;
  let cwd = process.cwd();
  let repair = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--cwd' && args[i + 1]) {
      cwd = resolve(args[i + 1]);
      i++;
    } else if (args[i] === '--repair') {
      repair = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
PenPage Agent - AI Coding Pad

Usage:
  penpage-agent [options]

Options:
  --port <number>   Server port (default: 3456)
  --cwd <path>      Project directory (default: current directory)
  --repair          Repair .sessions.json on startup (backup + dedup + cleanup)
  -h, --help        Show this help
`);
      process.exit(0);
    }
  }

  return { port, cwd, repair };
}

/** exec 子指令：直接執行 slash command 並輸出 markdown */
async function execCommand(input: string, cwd: string) {
  const parsed = parseCommand(input);
  if (!parsed) {
    console.error(`Unknown command: ${input}`);
    process.exit(1);
  }
  const ctx = { cwd, filename: 'cli-exec', sessionData: {} };
  const result = await executeCommand(parsed.name, parsed.args, ctx);
  if (!result) {
    console.error(`Command returned no result: ${input}`);
    process.exit(1);
  }
  process.stdout.write(result.markdown);
}

async function main() {
  // mcp 子指令：penpage-agent mcp [--cwd path]
  if (args[0] === 'mcp') {
    let cwd = process.cwd();
    const cwdIdx = args.indexOf('--cwd');
    if (cwdIdx !== -1 && args[cwdIdx + 1]) {
      cwd = resolve(args[cwdIdx + 1]);
    }
    await startMcpServer(cwd);
    return;
  }

  // exec 子指令：penpage-agent exec "/ls page" [--cwd path]
  if (args[0] === 'exec') {
    const input = args[1];
    if (!input) {
      console.error('Usage: penpage-agent exec "/command [args]" [--cwd path]');
      process.exit(1);
    }
    let cwd = process.cwd();
    const cwdIdx = args.indexOf('--cwd');
    if (cwdIdx !== -1 && args[cwdIdx + 1]) {
      cwd = resolve(args[cwdIdx + 1]);
    }
    await execCommand(input, cwd);
    return;
  }

  const { port, cwd, repair } = parseArgs();

  // 自動設定 MCP（首次啟動時寫入 ~/.claude/.mcp.json）
  const agentDir = resolve(__dirname, '../..');
  ensureMcpConfig(agentDir);

  // Auto-detect dev vs production: if src/client exists, we're in dev
  const srcClient = resolve(__dirname, '../../src/client');
  const dev = existsSync(srcClient);

  console.log(`\n  PenPage Agent`);
  console.log(`  Project: ${cwd}`);
  console.log(`  Mode:    ${dev ? 'development' : 'production'}`);
  console.log(`  Starting server...`);

  try {
    await createServer(port, cwd, dev, repair);
    const url = `http://127.0.0.1:${port}`;
    console.log(`  Server:  ${url}`);
    console.log(`\n  Press Ctrl+C to stop\n`);
    // 啟動 Telegram Bot（有 BOT_TOKEN 才啟動）
    const bot = startTelegramBot(cwd);
    if (!bot) {
      console.log('  Telegram: 未設定 BOT_TOKEN，跳過');
    }

    if (!dev) {
      await open(url);
    }
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main();
