import type { FastifyPluginAsync } from 'fastify';

export type HealthCheck = () => Promise<void>;

async function runCheck(check: HealthCheck): Promise<'up' | 'down'> {
  try {
    await check();
    return 'up';
  } catch {
    return 'down';
  }
}

export function healthRoutes({
  checks,
}: {
  checks: Record<string, HealthCheck>;
}): FastifyPluginAsync {
  return async (app) => {
    const config = { public: true };
    const schema = { hide: true };

    /** Liveness: the process is up. Never touches dependencies. */
    app.get('/health/live', { config, schema }, async () => ({ status: 'ok' }));

    /** Readiness: dependencies are reachable; load balancers stop routing on 503. */
    app.get('/health/ready', { config, schema }, async (_request, reply) => {
      const entries = await Promise.all(
        Object.entries(checks).map(async ([name, check]) => [name, await runCheck(check)] as const),
      );
      const ready = entries.every(([, state]) => state === 'up');
      return reply
        .code(ready ? 200 : 503)
        .send({ status: ready ? 'ok' : 'degraded', dependencies: Object.fromEntries(entries) });
    });
  };
}
