import { AIRunner } from './types.js';
import { claudeRunner } from './claude.js';
import { geminiRunner } from './gemini.js';
import { codexRunner } from './codex.js';

export const runners: AIRunner[] = [claudeRunner, geminiRunner, codexRunner];

export async function getAvailableRunners(): Promise<AIRunner[]> {
  const results = await Promise.all(
    runners.map(async (r) => ({ runner: r, available: await r.isAvailable() }))
  );
  return results.filter((r) => r.available).map((r) => r.runner);
}

export function getRunner(name: string): AIRunner | undefined {
  return runners.find((r) => r.name === name);
}

export type { AIRunner } from './types.js';
