export const API_URL = process.env.E2E_API_URL || 'http://localhost:5000/api';
export const FE_URL = process.env.E2E_FE_URL || 'http://localhost:3001';
export const ADMIN_URL = process.env.E2E_ADMIN_URL || 'http://localhost:3000';
export const CLEANUP_ENDPOINT =
  process.env.E2E_CLEANUP_ENDPOINT || 'http://localhost:5000/api/requests/test-utils/e2e-data';
export const TITLE_PREFIX = process.env.E2E_TITLE_PREFIX || '[E2E]';

// Fixed accounts from specialist-be/prisma/seed.ts — shared password for all seed users.
export const SEED_PASSWORD = 'Test1234!';

export const SEED_USERS = {
  client: { email: 'cliente1@test.com', password: SEED_PASSWORD },
  professional: { email: 'plomero@test.com', password: SEED_PASSWORD },
  admin: { email: 'admin@specialist.com', password: SEED_PASSWORD },
} as const;

export function e2eTitle(scenario: string): string {
  return `${TITLE_PREFIX} ${scenario} ${Date.now()}`;
}
