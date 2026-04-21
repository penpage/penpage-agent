import { spawn, execSync, ChildProcess } from 'child_process';
import { AIRunner } from './types.js';

export const claudeRunner: AIRunner = {
  name: 'claude',
  displayName: 'Claude Code',
  command: 'claude',

  async isAvailable(): Promise<boolean> {
    try {
      execSync('which claude', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },

  run(prompt: string, cwd: string): ChildProcess {
    const child = spawn('claude', ['-p', '--output-format', 'stream-json'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    child.stdin!.write(prompt);
    child.stdin!.end();
    return child;
  },
};
