import { spawn, execSync, ChildProcess } from 'child_process';
import { AIRunner } from './types.js';

export const codexRunner: AIRunner = {
  name: 'codex',
  displayName: 'Codex CLI',
  command: 'codex',

  async isAvailable(): Promise<boolean> {
    try {
      execSync('which codex', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },

  run(prompt: string, cwd: string): ChildProcess {
    const child = spawn('codex', ['exec', '--skip-git-repo-check', prompt], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    return child;
  },
};
