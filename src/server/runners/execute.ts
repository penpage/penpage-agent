import { ChildProcess } from 'child_process';
import { getRunner } from './index.js';
import { RunOptions } from './types.js';

// --- Types ---

export interface SessionInfo {
  id: string;
  model: string;
  cwd?: string;
  contextWindow?: number;
}

export interface ResultInfo {
  sessionId: string;
  cost: number;
  duration?: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  contextUsed: number;
  contextWindow: number;
}

export interface RunCallbacks {
  onText?: (text: string) => void;
  onSession?: (info: SessionInfo) => void;
  onResult?: (result: ResultInfo) => void;
  onError?: (error: string) => void;
}

export interface RunResult {
  text: string;
  session?: SessionInfo;
  result?: ResultInfo;
  exitCode: number | null;
}

// --- Core execution ---

export function runPrompt(
  tool: string,
  prompt: string,
  cwd: string,
  options?: RunOptions,
  callbacks?: RunCallbacks,
): { child: ChildProcess; done: Promise<RunResult> } {
  const runner = getRunner(tool);
  if (!runner) {
    throw new Error(`Unknown tool: ${tool}`);
  }

  const child = runner.run(prompt, cwd, options);

  const done = new Promise<RunResult>((resolve) => {
    let stdoutBuffer = '';
    let responseText = '';
    let sessionInfo: SessionInfo | undefined;
    let resultInfo: ResultInfo | undefined;

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        if (tool === 'claude') {
          try {
            const event = JSON.parse(line);

            // Init event
            if (event.type === 'system' && event.subtype === 'init') {
              const modelMatch = (event.model || '').match(/\[(\d+)([km])\]/);
              let contextWindow = 0;
              if (modelMatch) {
                contextWindow = parseInt(modelMatch[1]) * (modelMatch[2] === 'm' ? 1000000 : 1000);
              }
              sessionInfo = {
                id: event.session_id,
                model: event.model,
                cwd: event.cwd,
                contextWindow,
              };
              callbacks?.onSession?.(sessionInfo);
              continue;
            }

            // Assistant text
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'text') {
                  responseText += block.text;
                  callbacks?.onText?.(block.text);
                }
              }
              continue;
            }

            // Result event
            if (event.type === 'result') {
              const usage = event.usage || {};
              const contextUsed =
                (usage.input_tokens || 0) +
                (usage.output_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0);

              let contextWindow = 0;
              const modelUsage = event.modelUsage || {};
              for (const v of Object.values(modelUsage) as any[]) {
                if (v.contextWindow) {
                  contextWindow = v.contextWindow;
                  break;
                }
              }

              resultInfo = {
                sessionId: event.session_id,
                cost: event.total_cost_usd,
                duration: event.duration_ms,
                turns: event.num_turns,
                inputTokens: usage.input_tokens || 0,
                outputTokens: usage.output_tokens || 0,
                cacheRead: usage.cache_read_input_tokens || 0,
                cacheCreation: usage.cache_creation_input_tokens || 0,
                contextUsed,
                contextWindow,
              };
              callbacks?.onResult?.(resultInfo);
              continue;
            }
          } catch {
            // Partial JSON — skip
          }
        } else {
          // Gemini / Codex: raw text
          responseText += line + '\n';
          callbacks?.onText?.(line);
        }
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text || text.startsWith('Reading additional input')) return;
      callbacks?.onError?.(text);
    });

    child.on('close', (code: number | null) => {
      resolve({
        text: responseText,
        session: sessionInfo,
        result: resultInfo,
        exitCode: code,
      });
    });
  });

  return { child, done };
}
