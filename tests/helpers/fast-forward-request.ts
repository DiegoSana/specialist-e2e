import { request as pwRequest } from '@playwright/test';
import { API_URL, SEED_USERS } from './config';

async function login(email: string, password: string): Promise<string> {
  const ctx = await pwRequest.newContext();
  try {
    const res = await ctx.post(`${API_URL}/auth/login`, { data: { email, password } });
    if (!res.ok()) {
      throw new Error(
        `[fast-forward] login as ${email} failed (${res.status()}): ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { accessToken: string };
    return body.accessToken;
  } finally {
    await ctx.dispose();
  }
}

/**
 * simulate-reply publishes RequestInteractionRespondedEvent on the in-process EventBus, which
 * is fire-and-forget: the HTTP call returns before the handler finishes updating the request's
 * status. Poll instead of assuming the status already changed. Mirrors the identical helper in
 * specialist-be/test/scripts/seed-data/generate-diverse-requests.ts.
 */
async function waitForStatus(
  adminToken: string,
  requestId: string,
  expectedStatus: string,
  timeoutMs = 20_000,
): Promise<void> {
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
  throw new Error(`[fast-forward] timed out waiting for request ${requestId} to reach ${expectedStatus}`);
}

/** Drives CONTACT_RELEASED -> IN_PROGRESS via the WhatsApp admin dev tools (P1: "sí"). */
async function simulateAgreement(adminToken: string, requestId: string): Promise<void> {
  const ctx = await pwRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` },
  });
  try {
    await ctx.post(`${API_URL}/admin/whatsapp/conversations/${requestId}/trigger-followup`, {
      data: { ruleName: 'CONTACT_RELEASED_QUESTION_CLIENT_2D' },
    });
    await ctx.post(`${API_URL}/admin/whatsapp/conversations/${requestId}/simulate-reply`, {
      data: { body: 'Sí, dale, dale para adelante' },
    });
  } finally {
    await ctx.dispose();
  }
  await waitForStatus(adminToken, requestId, 'IN_PROGRESS');
}

/** Drives IN_PROGRESS -> FINISHED via the WhatsApp admin dev tools (P2: "terminé"). */
async function simulateProgressDone(adminToken: string, requestId: string): Promise<void> {
  const ctx = await pwRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` },
  });
  try {
    await ctx.post(`${API_URL}/admin/whatsapp/conversations/${requestId}/trigger-followup`, {
      data: { ruleName: 'IN_PROGRESS_QUESTION_7D' },
    });
    await ctx.post(`${API_URL}/admin/whatsapp/conversations/${requestId}/simulate-reply`, {
      // Deliberately avoids "listo": DetectResponseIntentUseCase resolves CONFIRMED keywords
      // before COMPLETED ones even though "listo" is in both lists, so a reply containing it
      // would be a no-op here instead of finishing the request (see generate-diverse-requests.ts).
      data: { body: 'Ya terminé el trabajo, quedó todo funcionando bien' },
    });
  } finally {
    await ctx.dispose();
  }
  await waitForStatus(adminToken, requestId, 'FINISHED');
}

/**
 * Drives a direct Request from just-created (SENT) to FINISHED purely via specialist-be's API —
 * this part isn't what review-moderation.spec.ts is testing, it's setup to reach a state where a
 * review can be left. Sequence verified against
 * specialist-be/test/scripts/seed-data/generate-diverse-requests.ts (its "CONTACT_RELEASED
 * (directo aceptado)" and "IN_PROGRESS" cases), not guessed:
 *
 * 1. The PROVIDER (not the client) accepts by PATCHing status to CONTACT_RELEASED directly —
 *    direct requests already have `providerId` set at creation, so no assign-provider call.
 * 2. CONTACT_RELEASED -> IN_PROGRESS and IN_PROGRESS -> FINISHED are each reachable ONLY through
 *    the WhatsApp follow-up simulation (trigger-followup + simulate-reply) — the backend's state
 *    machine does not accept a direct PATCH for either of those two transitions.
 *
 * Requires specialist-be running with WHATSAPP_PROVIDER=local (the docker-compose.dev.yml
 * default) — the /admin/whatsapp/conversations/:id/* dev-tools endpoints this depends on 404/403
 * once a real WhatsApp provider (Twilio) is configured.
 */
export async function fastForwardRequestToFinished(params: { requestId: string }): Promise<void> {
  const { requestId } = params;

  const professionalToken = await login(
    SEED_USERS.professional.email,
    SEED_USERS.professional.password,
  );
  const proCtx = await pwRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${professionalToken}` },
  });
  try {
    const res = await proCtx.patch(`${API_URL}/requests/${requestId}`, {
      data: { status: 'CONTACT_RELEASED' },
    });
    if (!res.ok()) {
      throw new Error(
        `[fast-forward] PATCH status=CONTACT_RELEASED on request ${requestId} failed ` +
          `(${res.status()}): ${await res.text()}`,
      );
    }
  } finally {
    await proCtx.dispose();
  }

  const adminToken = await login(SEED_USERS.admin.email, SEED_USERS.admin.password);
  await simulateAgreement(adminToken, requestId);
  await simulateProgressDone(adminToken, requestId);
}
