import { defineConfig, devices } from '@playwright/test';

/**
 * Two `projects` because specialist-fe (:3001) and specialist-admin (:3000) are
 * separate Next.js apps with separate origins/localStorage auth. `review-moderation.spec.ts`
 * touches both — it runs under the `admin` project (that's the part actually under
 * test: approving/rejecting a review) and reaches specialist-fe via absolute
 * `page.goto(process.env.E2E_FE_URL + ...)` calls for its setup steps, instead of
 * juggling per-block `test.use({ baseURL })` inside one file.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  // Specs share a small, fixed set of seed accounts (see prisma/seed.ts in
  // specialist-be) — running in serial avoids data races between specs.
  workers: 1,
  retries: 0,
  reporter: 'list',
  globalSetup: require.resolve('./tests/global-setup'),
  globalTeardown: require.resolve('./tests/global-teardown'),
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'fe',
      testMatch: /(auth|create-request-public|create-request-direct|job-board-interest)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.E2E_FE_URL || 'http://localhost:3001',
      },
    },
    {
      name: 'admin',
      testMatch: /(review-moderation|whatsapp-followup)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.E2E_ADMIN_URL || 'http://localhost:3000',
      },
    },
  ],
});
