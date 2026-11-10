import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logger } from '../lib/logger';

const WidgetErrorRequest = z.object({
  source: z.enum(['window-error', 'unhandled-rejection', 'fatal-render']),
  message: z.string().max(4000),
  stack: z.string().max(4000).optional(),
  pageUrl: z.string().max(2000).optional(),
  userAgent: z.string().max(500).optional(),
  sessionToken: z.string().max(200).optional(),
});

/** Receives crash/error reports from the widget running in a customer's browser on a partner's
 * site — the frontend counterpart to every other `logger.error` call in this codebase. Before this
 * route existed, a JS crash or stuck flow in the widget left literally no record anywhere except
 * that one customer's own (almost never open) devtools console (visibility gap found 2026-11-07).
 * No auth and no rate-limit exemption: the widget can crash before a session exists at all, so this
 * can't be gated behind a sessionToken — the app's existing global per-IP rate limit (see index.ts)
 * is the only thing standing between this and a crash-loop flooding the logs, same as any other
 * public endpoint. */
export async function widgetErrorRoutes(app: FastifyInstance) {
  app.post('/api/widget-error', async (req, reply) => {
    const body = WidgetErrorRequest.parse(req.body ?? {});
    logger.error({ widgetError: body }, 'widget frontend error report');
    return reply.code(204).send();
  });
}
