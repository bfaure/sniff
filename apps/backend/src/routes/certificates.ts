import type { FastifyInstance } from 'fastify';
import { getCACertPem } from '../proxy/ca.js';

export function certificateRoutes(fastify: FastifyInstance): void {
  fastify.get('/api/certificates/ca', async (_req, reply) => {
    const pem = getCACertPem();
    if (!pem) {
      return reply.code(404).send({ error: 'CA certificate not yet generated. Start the proxy first.' });
    }
    return reply
      .header('Content-Type', 'application/x-pem-file')
      .header('Content-Disposition', 'attachment; filename="sniff-ca.pem"')
      .send(pem);
  });
}
