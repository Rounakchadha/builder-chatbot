import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { loadSession } from '../services/session.service';
import { statusService } from '../services/status.service';

const StatusRequest = z.object({ sessionToken: z.string() });

/** Post-completion status polling — separate from the live chat flow. A returning customer (or a
 * standalone status page) can check on their lead after the conversation has already finished. */
export async function statusRoutes(app: FastifyInstance) {
  app.post('/api/status', async (req, reply) => {
    const body = StatusRequest.parse(req.body ?? {});
    const state = await loadSession(body.sessionToken);
    if (!state) return reply.code(404).send({ error: 'session_not_found' });

    const lead = await prisma.lead.findUnique({ where: { conversationId: state.conversationId } });
    if (!lead?.builderLeadId) return reply.code(404).send({ error: 'no_lead_for_session' });

    const status = await statusService.getStatus(lead.builderLeadId);
    return reply.send(status);
  });
}
