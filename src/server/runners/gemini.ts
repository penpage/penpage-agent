import { spawn, execSync, ChildProcess } from 'child_process';
import { AIRunner } from './types.js';

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

  run(prompt: string, cwd: string): ChildProcess {
    const child = spawn('gemini', ['-p', prompt], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    return child;
  },
};
