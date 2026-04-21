#!/usr/bin/env node

import { createServer } from '../server/index.js';
import open from 'open';
import { resolve } from 'path';

const args = process.argv.slice(2);

function parseArgs() {
  let port = 3456;
  let cwd = process.cwd();
  let dev = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--cwd' && args[i + 1]) {
      cwd = resolve(args[i + 1]);
      i++;
    } else if (args[i] === '--dev') {
      dev = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
PenPage Agent - AI Coding Pad

Usage:
  penpage-agent [options]

Options:
  --port <number>   Server port (default: 3456)
  --cwd <path>      Project directory (default: current directory)
  --dev             Development mode (no static files, no auto-open)
  -h, --help        Show this help
`);
      process.exit(0);
    }
  }

  return { port, cwd, dev };
}

async function main() {
  const { port, cwd, dev } = parseArgs();

  console.log(`\n  PenPage Agent`);
  console.log(`  Project: ${cwd}`);
  console.log(`  Starting server...`);

  try {
    await createServer(port, cwd, dev);
    const url = `http://127.0.0.1:${port}`;
    console.log(`  API:     ${url}`);

    if (dev) {
      console.log(`  Client:  run "npm run dev:client" in another terminal`);
    } else {
      await open(url);
    }

    console.log(`\n  Press Ctrl+C to stop\n`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main();
