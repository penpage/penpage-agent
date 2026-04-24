import { spawn, execSync, ChildProcess } from 'child_process';
import { AIRunner, RunOptions } from './types.js';

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

  run(prompt: string, cwd: string, options?: RunOptions): ChildProcess {
    const args = ['-p', '--output-format', 'stream-json'];
    if (options?.sessionId) {
      args.push('--resume', options.sessionId);
    }
    if (options?.model) {
      args.push('--model', options.model);
    }
    if (options?.permissionMode === 'plan') {
      args.push('--permission-mode', 'plan');
    } else {
      args.push('--permission-mode', 'acceptEdits');
    }
    if (options?.addDirs) {
      for (const dir of options.addDirs) {
        args.push('--add-dir', dir);
      }
    }

    const child = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    child.stdin!.write(prompt);
    child.stdin!.end();
    return child;
  },
};
