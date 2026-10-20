import { loadEnv } from './config/env.js';
import { createContainer } from './container.js';
import { runMigrations } from './db/migrate.js';
import { buildApp } from './http/app.js';
import { createLogger } from './lib/logger.js';
import { registerGracefulShutdown } from './lib/shutdown.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    name: 'ledgerly-api',
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });
  const container = createContainer(env, logger);

  // Safe with several replicas: the runner takes a Postgres advisory lock.
  await runMigrations(container.pool, (message) => logger.info(message));
  await container.redis.connect();

  const app = await buildApp(container);
  registerGracefulShutdown(logger, [() => app.close(), () => container.dispose()]);
  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((error: unknown) => {
  process.stderr.write(`Failed to start API: ${String(error)}\n`);
  process.exit(1);
});
