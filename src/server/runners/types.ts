import { ChildProcess } from 'child_process';

export interface AIRunner {
  name: string;
  displayName: string;
  command: string;
  isAvailable(): Promise<boolean>;
  run(prompt: string, cwd: string): ChildProcess;
}
