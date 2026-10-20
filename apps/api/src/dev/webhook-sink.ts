/**
 * Demo webhook receiver. Logs every event it receives and can be told to fail
 * a percentage of requests (SINK_FAILURE_RATE=0.3) to demonstrate retries.
 * Set SINK_SECRET to the endpoint's secret to verify signatures.
 */
import { createServer } from 'node:http';
import { SIGNATURE_HEADER, verifySignature } from '../workers/webhook-signature.js';

const port = Number(process.env.SINK_PORT ?? 4000);
const failureRate = Number(process.env.SINK_FAILURE_RATE ?? 0);
const secret = process.env.SINK_SECRET;
const received: Array<{
  receivedAt: string;
  type: string;
  id: string;
  signatureValid: boolean | null;
}> = [];

createServer((request, response) => {
  if (request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ count: received.length, recent: received.slice(-50).reverse() }));
    return;
  }

  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    if (Math.random() < failureRate) {
      response.writeHead(503).end();
      return;
    }

    const event = JSON.parse(body) as { id: string; type: string };
    const header = request.headers[SIGNATURE_HEADER];
    const signatureValid = secret
      ? verifySignature(secret, body, typeof header === 'string' ? header : undefined)
      : null;
    received.push({
      receivedAt: new Date().toISOString(),
      type: event.type,
      id: event.id,
      signatureValid,
    });
    process.stdout.write(`webhook ${event.type} ${event.id} signature=${String(signatureValid)}\n`);
    response.writeHead(signatureValid === false ? 401 : 200).end();
  });
}).listen(port, () => process.stdout.write(`Webhook sink listening on :${port}\n`));
