import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { corsAllowedOrigins, env } from './config/env';
import { logger } from './lib/logger';
import { redis } from './lib/redis';
import { chatRoutes } from './routes/chat';
import { statusRoutes } from './routes/status';

async function main() {
  const app = Fastify({ logger, trustProxy: env.TRUST_PROXY });

  await app.register(helmet);
  await app.register(cors, {
    origin: corsAllowedOrigins.length ? corsAllowedOrigins : false,
    credentials: false,
  });
  await app.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
    redis,
    keyGenerator: (req) => req.ip,
  });

  // Every route validates its body with `SomeSchema.parse(req.body)`, which throws a ZodError on
  // anything malformed — not just missing fields, but the wrong type for one too (e.g. a number
  // where a string was expected). Left uncaught, that ZodError propagated all the way to Fastify's
  // default error handler as an unhandled 500, dumping its full internal validation-issue list
  // (field names, expected/received types) straight into the response body. A malformed request is
  // a client mistake, not a server failure — it belongs as a clean 400 with no internal detail.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid_request', message: 'The request was malformed.' });
    }
    logger.error({ err: error }, 'unhandled request error');
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong. Please try again.' });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(chatRoutes);
  await app.register(statusRoutes);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info(`server listening on :${env.PORT}`);
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
