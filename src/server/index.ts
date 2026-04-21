import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { aiRoutes } from './routes/ai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function createServer(port: number, projectCwd: string, dev = false) {
  const app = Fastify({ logger: false });

  await app.register(fastifyCors, { origin: true });

  // Serve static client files (production only)
  if (!dev) {
    const clientDir = resolve(__dirname, '../client');
    if (existsSync(clientDir)) {
      await app.register(fastifyStatic, {
        root: clientDir,
        prefix: '/',
      });
    }
  }

  // Register API routes
  await app.register(aiRoutes);

  // Pass default cwd to client
  app.get('/api/config', async () => ({
    cwd: projectCwd,
  }));

  await app.listen({ port, host: '127.0.0.1' });
  return app;
}
