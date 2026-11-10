import path from 'node:path';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { corsAllowedOrigins, env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { chatRoutes } from './routes/chat';
import { statusRoutes } from './routes/status';
import { adminRoutes } from './routes/admin';
import { widgetErrorRoutes } from './routes/widgetError';

async function main() {
  // disableRequestLogging: true — Fastify's own automatic "incoming request"/"request completed"
  // lines fire from a hook that runs before per-route config (like logLevel) is applied, so trying
  // to silence just /health via a route-level logLevel (tried 2026-11-10) didn't work in practice —
  // confirmed live: still showed up after that fix was deployed. Replaced with one manual hook below
  // that logs everything EXCEPT /health, in a single line per request instead of Fastify's own two.
  const app = Fastify({ logger, trustProxy: env.TRUST_PROXY, bodyLimit: 1 * 1024 * 1024, disableRequestLogging: true });

  // See the comment above — docker-compose's healthcheck hits /health every 10s (24,000+ of
  // ~48,500 log lines over 3 real days were just this), which is useful for Docker's own
  // restart-on-unhealthy behavior but tells us nothing worth keeping a record of.
  app.addHook('onResponse', async (request, reply) => {
    if (request.routeOptions.url === '/health') return;
    logger.info({ event: 'request_completed', method: request.method, url: request.url, statusCode: reply.statusCode, responseTimeMs: reply.elapsedTime }, 'request completed');
  });

  // contentSecurityPolicy: false — this server now also serves the static demo page (see the
  // @fastify/static registration below), which relies on inline <script>/<style> tags; helmet's
  // default CSP blocks those outright. The demo page is UAT-only test tooling, not the production
  // embed (real sites load just widget.js, never this server's HTML) — fine to relax it here.
  //
  // crossOriginResourcePolicy: 'cross-origin' — bug found 2026-11-10: Helmet's default here is
  // 'same-origin', a DIFFERENT mechanism from CORS (corsAllowedOrigins below only governs fetch/XHR
  // API calls). 'same-origin' CORP tells the browser to block plain <img>/font loads from any other
  // origin, regardless of CORS — confirmed live: CIS's embedded widget (beta.countinfinity.ai)
  // showed eligibility results fine (API calls, covered by CORS) but every lender logo image came
  // up broken. This server's entire purpose is being embedded by partner domains, so every static
  // asset (lender logos, fonts, widget.js itself) needs to be loadable cross-origin by design.
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(cors, {
    origin: corsAllowedOrigins.length ? corsAllowedOrigins : false,
    credentials: false,
  });
  await app.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
    redis,
    keyGenerator: (req) => req.ip,
    // Security-review finding, 2026-10-23: without this, the rate limiter's own Redis lookup
    // throwing (Redis down/unreachable) propagated as an uncaught error on EVERY request — a Redis
    // outage took the entire app down, including /health, rather than just losing rate limiting
    // (the much smaller, acceptable degradation) until Redis comes back.
    skipOnError: true,
    // Bug fixed 2026-11-02: lender logos/background images/fonts used to be inlined straight into
    // widget.js (zero extra requests) — once they became real static files under /assets/ and
    // /widget.js itself, a single page load now fires 10-30 GETs for them, which used to count
    // against the same 60-per-minute budget meant for the chat API. A couple of page reloads was
    // enough to exhaust it and start 500ing real /api/chat/* calls too. This isn't the API surface
    // the limit was ever meant to protect, so it's exempted entirely.
    allowList: (req) => req.url.startsWith('/assets/') || req.url.startsWith('/widget') || req.url === '/' || req.url.startsWith('/index.html') || req.url.startsWith('/sdk-demo.html'),
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
    // Bug fixed 2026-11-02: @fastify/rate-limit throws its own error with statusCode 429 on it, but
    // this always sent back a flat 500 "Something went wrong" regardless — so a rate-limited
    // request looked exactly like a genuine server crash to both the customer and our own logs'
    // response status, instead of the real "slow down" signal.
    if (error.statusCode === 429) {
      return reply.code(429).send({ error: 'too_many_requests', message: error.message });
    }
    logger.error({ err: error }, 'unhandled request error');
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong. Please try again.' });
  });

  // Security-review finding, 2026-10-23: this used to always return {status:'ok'} with no actual
  // check — a container orchestrator (or the docker-compose healthcheck below) would report this
  // app as healthy even with Postgres or Redis fully down. Each check gets its own short timeout so
  // a slow/hanging dependency can't make /health itself hang — an unhealthy result fast is far more
  // useful than a correct result that times out.
  async function pingWithTimeout(fn: () => Promise<unknown>, ms: number): Promise<boolean> {
    try {
      await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
      return true;
    } catch {
      return false;
    }
  }
  app.get('/health', async (_req, reply) => {
    const [postgresOk, redisOk] = await Promise.all([
      pingWithTimeout(() => prisma.$queryRaw`SELECT 1`, 2000),
      pingWithTimeout(() => redis.ping(), 2000),
    ]);
    const ok = postgresOk && redisOk;
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', postgres: postgresOk, redis: redisOk });
  });

  await app.register(chatRoutes);
  await app.register(statusRoutes);
  await app.register(adminRoutes);
  await app.register(widgetErrorRoutes);

  // Serves the demo page + built widget.js directly from this same server/port, so the public
  // domain's existing `ProxyPass / -> :8091` Apache config already works with no vhost changes —
  // registered last so /api/*, /health, /admin/* above still take priority over same-named static
  // files. dist/index.js lives at /app/server/dist/index.js in the image; test-page is copied to
  // /app/test-page alongside it (see Dockerfile).
  await app.register(staticFiles, { root: path.join(__dirname, '..', '..', 'test-page') });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info(`server listening on :${env.PORT}`);

  // Security-review finding, 2026-10-23: with no SIGTERM handler, a deploy/restart killed the
  // process immediately — including mid-flight requests like a real lead being created with
  // Finfinity. fastify.close() waits for in-flight requests to finish (and runs onClose hooks)
  // before resolving, giving those a real chance to complete instead of being cut off.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      logger.info({ signal }, 'shutting down gracefully');
      try {
        await app.close();
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'error during graceful shutdown');
        process.exit(1);
      }
    });
  }
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
