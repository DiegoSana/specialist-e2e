import { request as pwRequest } from '@playwright/test';
import { API_URL, SEED_USERS } from './config';

/**
 * Looks up a just-created request's id via the API instead of clicking through the dashboard's
 * tabbed UI to find it — with accumulated E2E data across runs (no cleanup endpoint yet, see
 * TODO.md) the dashboard can take longer to render/tab-switch than is worth racing against in a
 * test that isn't exercising that UI anyway. `GET /requests` (client's own, newest first) is the
 * stable source of truth for "did creation succeed, and what's its id".
 */
export async function findRequestIdByTitle(title: string): Promise<string> {
  const ctx = await pwRequest.newContext();
  try {
    const loginRes = await ctx.post(`${API_URL}/auth/login`, { data: SEED_USERS.client });
    if (!loginRes.ok()) {
      throw new Error(`[requests] client login failed (${loginRes.status()})`);
    }
    const { accessToken } = (await loginRes.json()) as { accessToken: string };
    const listRes = await ctx.get(`${API_URL}/requests`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const list = (await listRes.json()) as Array<{ id: string; title: string }>;
    const match = list.find((r) => r.title === title);
    if (!match) {
      throw new Error(`[requests] request with title "${title}" not found via API`);
    }
    return match.id;
  } finally {
    await ctx.dispose();
  }
}

/** The provider (not the client) accepts a direct request by PATCHing status to
 * CONTACT_RELEASED — the only status_transition reachable by a direct PATCH (everything past
 * this point requires a WhatsApp follow-up round-trip, see tests/helpers/whatsapp.ts). */
export async function providerAcceptsRequest(requestId: string): Promise<void> {
  const ctx = await pwRequest.newContext();
  try {
    const loginRes = await ctx.post(`${API_URL}/auth/login`, { data: SEED_USERS.professional });
    if (!loginRes.ok()) {
      throw new Error(`[requests] professional login failed (${loginRes.status()})`);
    }
    const { accessToken } = (await loginRes.json()) as { accessToken: string };
    const res = await ctx.patch(`${API_URL}/requests/${requestId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { status: 'CONTACT_RELEASED' },
    });
    if (!res.ok()) {
      throw new Error(
        `[requests] provider accept on ${requestId} failed (${res.status()}): ${await res.text()}`,
      );
    }
  } finally {
    await ctx.dispose();
  }
}
