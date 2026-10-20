import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration suites share one database, so files run one at a time.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/server.ts',
        'src/relay.ts',
        'src/dispatcher.ts',
        'src/dev/**',
        'src/db/migrate-cli.ts',
      ],
      reporter: ['text', 'lcov'],
    },
  },
});
