import { ChildProcess } from 'child_process';

export interface RunOptions {
  sessionId?: string;
  model?: string;
}

export interface AIRunner {
  name: string;
  displayName: string;
  command: string;
  isAvailable(): Promise<boolean>;
  run(prompt: string, cwd: string, options?: RunOptions): ChildProcess;
}
