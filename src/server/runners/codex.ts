import { spawn, execSync, ChildProcess } from 'child_process';
import { AIRunner, RunOptions } from './types.js';

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

  run(prompt: string, cwd: string, options?: RunOptions): ChildProcess {
    const args = ['exec', '--skip-git-repo-check'];
    if (options?.model) {
      args.push('--model', options.model);
    }
    args.push(prompt);
    const child = spawn('codex', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    return child;
  },
};
