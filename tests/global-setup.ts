import type { FullConfig } from '@playwright/test';
import { request } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { API_URL, FE_URL, ADMIN_URL, SEED_USERS } from './helpers/config';

/**
 * Logs in the fixed seed accounts (specialist-be/prisma/seed.ts) via the real
 * `/auth/login` API — no OAuth, no UI — and writes one Playwright `storageState`
 * file per role, so specs that don't test login itself can start already
 * authenticated via `test.use({ storageState: '.auth/<role>.json' })`.
 *
 * specialist-fe (`lib/auth.ts`) stores the session as plain localStorage keys
 * `token` (JWT string) and `user` (JSON string) — no cookies.
 * specialist-admin (`hooks/use-admin-auth.ts`) stores it as localStorage key
 * `admin_token` — a different key, different origin.
 *
 * Fails loudly (not silently) if a login fails: that almost always means
 * specialist-be isn't running or `npm run db:seed` hasn't been run yet, which is
 * a documented precondition (see CLAUDE.md), not something this setup should
 * paper over.
 */

interface LoginResponse {
  accessToken: string;
  user: unknown;
}

async function login(email: string, password: string): Promise<LoginResponse> {
  const ctx = await request.newContext();
  const res = await ctx.post(`${API_URL}/auth/login`, { data: { email, password } });
  if (!res.ok()) {
    throw new Error(
      `[global-setup] Login failed for ${email} against ${API_URL}/auth/login (status ${res.status()}). ` +
        `Is specialist-be running (docker compose -f ../specialist-be/docker-compose.dev.yml up -d) ` +
        `and seeded (npm run db:seed inside specialist-be)? Response: ${await res.text()}`,
    );
  }
  const body = (await res.json()) as LoginResponse;
  await ctx.dispose();
  return body;
}

async function writeStorageState(
  outFile: string,
  origin: string,
  localStorage: { name: string; value: string }[],
) {
  const state = {
    cookies: [],
    origins: [{ origin, localStorage }],
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(state, null, 2));
}

export default async function globalSetup(_config: FullConfig) {
  const [client, professional, admin] = await Promise.all([
    login(SEED_USERS.client.email, SEED_USERS.client.password),
    login(SEED_USERS.professional.email, SEED_USERS.professional.password),
    login(SEED_USERS.admin.email, SEED_USERS.admin.password),
  ]);

  await writeStorageState(path.join(__dirname, '..', '.auth', 'client.json'), FE_URL, [
    { name: 'token', value: client.accessToken },
    { name: 'user', value: JSON.stringify(client.user) },
  ]);

  await writeStorageState(path.join(__dirname, '..', '.auth', 'professional.json'), FE_URL, [
    { name: 'token', value: professional.accessToken },
    { name: 'user', value: JSON.stringify(professional.user) },
  ]);

  await writeStorageState(path.join(__dirname, '..', '.auth', 'admin.json'), ADMIN_URL, [
    { name: 'admin_token', value: admin.accessToken },
  ]);

  // Also stash the raw admin token for helpers that call specialist-be directly
  // (e.g. review-moderation.spec.ts fast-forwarding a Request's status via API).
  fs.writeFileSync(
    path.join(__dirname, '..', '.auth', 'admin-token.txt'),
    admin.accessToken,
  );
}
