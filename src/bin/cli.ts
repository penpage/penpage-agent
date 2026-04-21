#!/usr/bin/env node

import { createServer } from '../server/index.js';
import open from 'open';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function parseArgs() {
  let port = 3456;
  let cwd = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--cwd' && args[i + 1]) {
      cwd = resolve(args[i + 1]);
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
PenPage Agent - AI Coding Pad

Usage:
  penpage-agent [options]

Options:
  --port <number>   Server port (default: 3456)
  --cwd <path>      Project directory (default: current directory)
  -h, --help        Show this help
`);
      process.exit(0);
    }
  }

  return { port, cwd };
}

async function main() {
  const { port, cwd } = parseArgs();

  // Auto-detect dev vs production: if src/client exists, we're in dev
  const srcClient = resolve(__dirname, '../../src/client');
  const dev = existsSync(srcClient);

  console.log(`\n  PenPage Agent`);
  console.log(`  Project: ${cwd}`);
  console.log(`  Mode:    ${dev ? 'development' : 'production'}`);
  console.log(`  Starting server...`);

  try {
    await createServer(port, cwd, dev);
    const url = `http://127.0.0.1:${port}`;
    console.log(`  Server:  ${url}`);
    console.log(`\n  Press Ctrl+C to stop\n`);
    if (!dev) {
      await open(url);
    }
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main();
