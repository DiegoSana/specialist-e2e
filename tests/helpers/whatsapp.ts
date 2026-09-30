import { request as pwRequest } from '@playwright/test';
import { API_URL, SEED_USERS } from './config';

export interface WhatsAppInteraction {
  id: string;
  requestId: string;
  interactionType: string;
  status: string;
  direction: string;
  channel: string;
  messageTemplate: string;
  messageContent: string;
  responseContent: string | null;
  responseIntent: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  respondedAt: string | null;
  twilioMessageSid: string | null;
  twilioStatus: string | null;
  metadata: { recipientPhone?: string; rule?: string; [key: string]: unknown } | null;
  createdAt: string;
  updatedAt: string;
}

async function login(email: string, password: string): Promise<string> {
  const ctx = await pwRequest.newContext();
  try {
    const res = await ctx.post(`${API_URL}/auth/login`, { data: { email, password } });
    if (!res.ok()) {
      throw new Error(`[whatsapp] login as ${email} failed (${res.status()}): ${await res.text()}`);
    }
    const body = (await res.json()) as { accessToken: string };
    return body.accessToken;
  } finally {
    await ctx.dispose();
  }
}

let cachedAdminToken: string | null = null;
async function getAdminToken(): Promise<string> {
  if (!cachedAdminToken) {
    cachedAdminToken = await login(SEED_USERS.admin.email, SEED_USERS.admin.password);
  }
  return cachedAdminToken;
}

/**
 * API-level equivalent of the admin UI's "Forzar seguimiento ahora" button
 * (`POST /admin/whatsapp/conversations/:id/trigger-followup`). Works with any
 * `WHATSAPP_PROVIDER` (sends synchronously, bypasses the cron/ladder-step guards) — see
 * specialist-be/src/requests/CLAUDE.md. Utility for setup in other specs; the main
 * whatsapp-followup.spec.ts flow drives this via the real admin UI instead, since exercising
 * that panel is the point of the test.
 */
export async function forceFollowUpViaApi(
  requestId: string,
  ruleName: string,
): Promise<{ interactionId: string }> {
  const adminToken = await getAdminToken();
  const ctx = await pwRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` },
  });
  try {
    const res = await ctx.post(
      `${API_URL}/admin/whatsapp/conversations/${requestId}/trigger-followup`,
      { data: { ruleName } },
    );
    if (!res.ok()) {
      throw new Error(
        `[whatsapp] trigger-followup ${ruleName} on ${requestId} failed (${res.status()}): ${await res.text()}`,
      );
    }
    return (await res.json()) as { interactionId: string };
  } finally {
    await ctx.dispose();
  }
}

/**
 * `GET /admin/whatsapp/conversations/:id` — the full interaction thread, newest-first as the API
 * returns it (the admin UI reverses this client-side to render oldest-first). The DOM never shows
 * `messageTemplate`/`twilioMessageSid`/`metadata` (confirmed by exploring the thread page), so
 * reading this API directly is the only way to get them for building a webhook payload.
 */
export async function getThread(requestId: string): Promise<WhatsAppInteraction[]> {
  const adminToken = await getAdminToken();
  const ctx = await pwRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` },
  });
  try {
    const res = await ctx.get(`${API_URL}/admin/whatsapp/conversations/${requestId}`);
    if (!res.ok()) {
      throw new Error(
        `[whatsapp] get thread for ${requestId} failed (${res.status()}): ${await res.text()}`,
      );
    }
    return (await res.json()) as WhatsAppInteraction[];
  } finally {
    await ctx.dispose();
  }
}

/**
 * Simulates a client/provider WhatsApp reply by POSTing directly to the real Twilio webhook
 * (`/api/webhooks/twilio`) — NOT the dev-only `/admin/whatsapp/.../simulate-reply` endpoint,
 * which only works when `WHATSAPP_PROVIDER=local`. The webhook's inbound-processing code
 * (`RequestInteractionService.processInboundMessage`) has zero branch on `WHATSAPP_PROVIDER` —
 * it's the exact same function `simulate-reply` wraps — so this works identically under any
 * provider, *as long as the outbound send that created `messageSid` actually succeeded*: only a
 * successful `sendMessage` stores `twilioMessageSid`/`recipientPhone` on the interaction, so a
 * failed send can never be matched by anything posted here (verified against
 * request-interaction.service.ts, not assumed).
 *
 * Payload shape matches the repo's own reference script,
 * specialist-be/test/scripts/whatsapp/utilities/simulate-webhook.sh.
 */
export async function simulateWhatsAppReply(params: {
  messageSid: string;
  from: string;
  body: string;
}): Promise<void> {
  const { messageSid, from, body } = params;
  const ctx = await pwRequest.newContext();
  try {
    const fromWhatsApp = from.startsWith('whatsapp:') ? from : `whatsapp:${from}`;
    const res = await ctx.post(`${API_URL}/webhooks/twilio`, {
      data: { MessageSid: messageSid, From: fromWhatsApp, Body: body, AccountSid: 'ACtest' },
    });
    if (!res.ok()) {
      throw new Error(
        `[whatsapp] simulated webhook reply failed (${res.status()}): ${await res.text()}`,
      );
    }
  } finally {
    await ctx.dispose();
  }
}

/** Polls `GET /requests/:id` until it reaches `expectedStatus` or times out. */
export async function waitForRequestStatus(
  requestId: string,
  expectedStatus: string,
  timeoutMs = 20_000,
): Promise<void> {
  const adminToken = await getAdminToken();
  const ctx = await pwRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` },
  });
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await ctx.get(`${API_URL}/requests/${requestId}`);
      const body = (await res.json()) as { status: string };
      if (body.status === expectedStatus) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  } finally {
    await ctx.dispose();
  }
  throw new Error(
    `[whatsapp] timed out waiting for request ${requestId} to reach ${expectedStatus}`,
  );
}

/**
 * Finds the most recently sent `FOLLOW_UP` interaction for a given rule/template — used right
 * after forcing a follow-up (via UI or API) to get the `twilioMessageSid`/`recipientPhone` needed
 * to simulate the reply. Matches by `metadata.rule` (stored by the scheduler/force-trigger path
 * even though the admin UI never displays it).
 */
export function findSentInteraction(
  thread: WhatsAppInteraction[],
  ruleName: string,
): WhatsAppInteraction | undefined {
  return thread
    .filter((i) => i.metadata?.rule === ruleName && i.status === 'SENT')
    .sort((a, b) => new Date(b.sentAt ?? b.createdAt).getTime() - new Date(a.sentAt ?? a.createdAt).getTime())[0];
}
