import { FastifyInstance } from 'fastify';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getAvailableRunners, getRunner } from '../runners/index.js';

export async function aiRoutes(app: FastifyInstance) {
  // List available AI tools
  app.get('/api/ai/tools', async () => {
    const available = await getAvailableRunners();
    return {
      tools: available.map((r) => ({
        name: r.name,
        displayName: r.displayName,
      })),
    };
  });

  // List recent Claude sessions
  app.get('/api/ai/sessions', async (request) => {
    const { cwd } = request.query as { cwd?: string };
    const sessionsDir = join(homedir(), '.claude', 'sessions');

    try {
      const files = readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            const data = JSON.parse(readFileSync(join(sessionsDir, f), 'utf-8'));
            return {
              sessionId: data.sessionId,
              name: data.name,
              cwd: data.cwd,
              startedAt: data.startedAt,
              kind: data.kind,
            };
          } catch {
            return null;
          }
        })
        .filter((s): s is NonNullable<typeof s> => s !== null)
        // Filter by cwd if specified
        .filter((s) => !cwd || s.cwd === cwd)
        // Sort by most recent first
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 10);

      return { sessions: files };
    } catch {
      return { sessions: [] };
    }
  });

  // Get last exchanges from a session
  app.get('/api/ai/sessions/:sessionId/preview', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const { cwd: projectCwd } = request.query as { cwd?: string };

    // Build project path pattern from cwd
    const projectPath = (projectCwd || '').replace(/\//g, '-').replace(/^-/, '');
    const possibleDirs = [
      join(homedir(), '.claude', 'projects', projectPath),
      join(homedir(), '.claude', 'projects', `-${projectPath}`),
    ];

    let jsonlPath = '';
    for (const dir of possibleDirs) {
      const candidate = join(dir, `${sessionId}.jsonl`);
      try {
        readFileSync(candidate, { flag: 'r' });
        jsonlPath = candidate;
        break;
      } catch {
        // Try next
      }
    }

    if (!jsonlPath) {
      // Try to find by scanning all project dirs
      const projectsDir = join(homedir(), '.claude', 'projects');
      try {
        for (const dir of readdirSync(projectsDir)) {
          const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
          try {
            readFileSync(candidate, { flag: 'r' });
            jsonlPath = candidate;
            break;
          } catch {
            // continue
          }
        }
      } catch {
        // projects dir not found
      }
    }

    if (!jsonlPath) {
      return { exchanges: [] };
    }

    try {
      const content = readFileSync(jsonlPath, 'utf-8');
      const lines = content.trim().split('\n');

      const exchanges: Array<{ role: string; text: string }> = [];
      let lastUsage: {
        inputTokens: number;
        outputTokens: number;
        cacheRead: number;
        cacheCreation: number;
        contextUsed: number;
      } | null = null;
      let totalCost = 0;
      let turnCount = 0;

      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          const msg = d.message || {};
          const role = msg.role || '';
          const contentArr = msg.content;

          // Extract text exchanges
          if (Array.isArray(contentArr)) {
            for (const c of contentArr) {
              if (c.type === 'text' && c.text && c.text.length > 3) {
                exchanges.push({
                  role: role === 'user' ? 'user' : 'assistant',
                  text: c.text.slice(0, 300),
                });
              }
            }
          } else if (typeof contentArr === 'string' && contentArr.length > 3) {
            exchanges.push({
              role: role === 'user' ? 'user' : 'assistant',
              text: contentArr.slice(0, 300),
            });
          }

          // Extract usage from assistant messages
          const usage = msg.usage;
          if (usage && role === 'assistant') {
            const input = usage.input_tokens || 0;
            const output = usage.output_tokens || 0;
            const cacheRead = usage.cache_read_input_tokens || 0;
            const cacheCreation = usage.cache_creation_input_tokens || 0;
            lastUsage = {
              inputTokens: input,
              outputTokens: output,
              cacheRead,
              cacheCreation,
              contextUsed: input + output + cacheRead + cacheCreation,
            };
            turnCount++;
          }

          // Extract cost from costUSD field if present
          if (d.costUSD) {
            totalCost += d.costUSD;
          }
        } catch {
          // Skip malformed lines
        }
      }

      return {
        exchanges: exchanges.slice(-6),
        usage: lastUsage,
        turns: turnCount,
        totalCost,
      };
    } catch {
      return { exchanges: [] };
    }
  });

  // Run AI prompt with SSE streaming
  app.post('/api/ai/run', async (request, reply) => {
    const { prompt, tool, cwd, sessionId, model, permissionMode } = request.body as {
      prompt: string;
      tool: string;
      cwd: string;
      sessionId?: string;
      model?: string;
      permissionMode?: 'auto' | 'plan';
    };

    if (!prompt || !tool || !cwd) {
      return reply.code(400).send({ error: 'Missing prompt, tool, or cwd' });
    }

    const runner = getRunner(tool);
    if (!runner) {
      return reply.code(400).send({ error: `Unknown tool: ${tool}` });
    }

    const available = await runner.isAvailable();
    if (!available) {
      return reply.code(400).send({ error: `${tool} CLI is not installed` });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const child = runner.run(prompt, cwd, { sessionId, model, permissionMode });

    // Buffer for incomplete JSON lines
    let stdoutBuffer = '';

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      // Keep last incomplete line in buffer
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        if (tool === 'claude') {
          try {
            const event = JSON.parse(line);

            // Init event — send session info
            if (event.type === 'system' && event.subtype === 'init') {
              // Extract context window from model name pattern (e.g. claude-opus-4-6[1m])
              const modelMatch = (event.model || '').match(/\[(\d+)([km])\]/);
              let contextWindow = 0;
              if (modelMatch) {
                contextWindow = parseInt(modelMatch[1]) * (modelMatch[2] === 'm' ? 1000000 : 1000);
              }
              reply.raw.write(`data: ${JSON.stringify({
                session: {
                  id: event.session_id,
                  model: event.model,
                  cwd: event.cwd,
                  contextWindow,
                },
              })}\n\n`);
              continue;
            }

            // Assistant message — stream text
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'text') {
                  reply.raw.write(`data: ${JSON.stringify({ text: block.text })}\n\n`);
                }
              }
              continue;
            }

            // Result event — send cost/usage info
            if (event.type === 'result') {
              const usage = event.usage || {};
              const contextUsed =
                (usage.input_tokens || 0) +
                (usage.output_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0);

              // Get contextWindow from modelUsage if available
              let contextWindow = 0;
              const modelUsage = event.modelUsage || {};
              for (const v of Object.values(modelUsage) as any[]) {
                if (v.contextWindow) {
                  contextWindow = v.contextWindow;
                  break;
                }
              }

              reply.raw.write(`data: ${JSON.stringify({
                result: {
                  sessionId: event.session_id,
                  cost: event.total_cost_usd,
                  duration: event.duration_ms,
                  turns: event.num_turns,
                  contextUsed,
                  contextWindow,
                  inputTokens: usage.input_tokens || 0,
                  outputTokens: usage.output_tokens || 0,
                  cacheRead: usage.cache_read_input_tokens || 0,
                  cacheCreation: usage.cache_creation_input_tokens || 0,
                },
              })}\n\n`);
              continue;
            }
          } catch {
            // Partial JSON — skip
          }
        } else {
          // Gemini / Codex: send raw text
          reply.raw.write(`data: ${JSON.stringify({ text: line })}\n\n`);
        }
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text || text.startsWith('Reading additional input')) return;
      reply.raw.write(`data: ${JSON.stringify({ error: text })}\n\n`);
    });

    child.on('close', (code: number | null) => {
      reply.raw.write(`data: ${JSON.stringify({ done: true, exitCode: code })}\n\n`);
      reply.raw.end();
    });

    request.raw.on('close', () => {
      child.kill('SIGTERM');
    });
  });
}
