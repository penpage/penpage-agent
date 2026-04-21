import { spawn, execSync, ChildProcess } from 'child_process';
import { AIRunner, RunOptions } from './types.js';

export const geminiRunner: AIRunner = {
  name: 'gemini',
  displayName: 'Gemini CLI',
  command: 'gemini',

  async isAvailable(): Promise<boolean> {
    try {
      execSync('which gemini', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },

  run(prompt: string, cwd: string, options?: RunOptions): ChildProcess {
    const args = ['-p', prompt];
    if (options?.model) {
      args.push('--model', options.model);
    }
    const child = spawn('gemini', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    return child;
  },
};
