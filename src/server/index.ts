import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import middie from '@fastify/middie';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { aiRoutes } from './routes/ai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function createServer(port: number, projectCwd: string, dev = false) {
  const app = Fastify({ logger: false });

  await app.register(fastifyCors, { origin: true });
  await app.register(middie);

  // Register API routes first (higher priority)
  await app.register(aiRoutes);

  app.get('/api/config', async () => ({
    cwd: projectCwd,
  }));

  if (dev) {
    // Dev: Vite middleware mode (HMR, TS compilation)
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root: resolve(__dirname, '../../src/client'),
      server: { middlewareMode: true },
    });
    // Skip Vite for API routes — let Fastify handle them
    app.use((req, res, next) => {
      if (req.url?.startsWith('/api/')) {
        next();
      } else {
        vite.middlewares(req, res, next);
      }
    });
  } else {
    // Production: serve built static files
    const clientDir = resolve(__dirname, '../client');
    if (existsSync(clientDir)) {
      await app.register(fastifyStatic, {
        root: clientDir,
        prefix: '/',
      });
    }
  }

  await app.listen({ port, host: '127.0.0.1' });
  return app;
}
