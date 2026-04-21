import { FastifyInstance } from 'fastify';
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

  // Run AI prompt with SSE streaming
  app.post('/api/ai/run', async (request, reply) => {
    const { prompt, tool, cwd } = request.body as {
      prompt: string;
      tool: string;
      cwd: string;
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

    const child = runner.run(prompt, cwd);

    child.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();

      if (tool === 'claude') {
        // Claude stream-json: each line is a JSON object
        const lines = text.split('\n').filter((l: string) => l.trim());
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'text') {
                  reply.raw.write(`data: ${JSON.stringify({ text: block.text })}\n\n`);
                }
              }
            }
          } catch {
            // Partial JSON, send as raw text
            reply.raw.write(`data: ${JSON.stringify({ text: line })}\n\n`);
          }
        }
      } else {
        // Gemini / Codex: send raw text
        reply.raw.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      // Skip progress/info messages from stderr
      if (!text || text.startsWith('Reading additional input')) return;
      reply.raw.write(`data: ${JSON.stringify({ error: text })}\n\n`);
    });

    child.on('close', (code: number | null) => {
      reply.raw.write(`data: ${JSON.stringify({ done: true, exitCode: code })}\n\n`);
      reply.raw.end();
    });

    // Handle client disconnect
    request.raw.on('close', () => {
      child.kill('SIGTERM');
    });
  });
}
