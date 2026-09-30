import { request as pwRequest } from '@playwright/test';
import { API_URL, SEED_USERS } from './config';
import { findSentInteraction, forceFollowUpViaApi, getThread, simulateWhatsAppReply, waitForRequestStatus } from './whatsapp';

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
 * Forces a follow-up rule and simulates the recipient's reply via the real Twilio webhook (not
 * the dev-only `simulate-reply` endpoint — see tests/helpers/whatsapp.ts for why that matters:
 * this works under any `WHATSAPP_PROVIDER`, as long as the outbound send itself succeeds).
 */
async function forceAndReply(requestId: string, ruleName: string, replyBody: string, expectedStatus: string) {
  await forceFollowUpViaApi(requestId, ruleName);
  const thread = await getThread(requestId);
  const interaction = findSentInteraction(thread, ruleName);
  if (!interaction || !interaction.twilioMessageSid || !interaction.metadata?.recipientPhone) {
    throw new Error(
      `[fast-forward] rule ${ruleName} on request ${requestId} produced no matchable SENT interaction ` +
        `(twilioMessageSid/recipientPhone missing — the outbound send likely failed; check WHATSAPP_PROVIDER).`,
    );
  }
  await simulateWhatsAppReply({
    messageSid: interaction.twilioMessageSid,
    from: interaction.metadata.recipientPhone,
    body: replyBody,
  });
  await waitForRequestStatus(requestId, expectedStatus);
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
 *    the WhatsApp follow-up simulation (force a rule + a reply that resolves to the right
 *    intent) — the backend's state machine does not accept a direct PATCH for either transition.
 *
 * Provider-agnostic: forcing the follow-up (`trigger-followup`) works with any
 * `WHATSAPP_PROVIDER`, and so does simulating the reply (the webhook itself). The one thing that
 * still needs `WHATSAPP_PROVIDER=local` to be side-effect-free is the outbound send triggered by
 * `trigger-followup` not attempting a real Twilio call to a fake seed phone number — see
 * specialist-e2e/CLAUDE.md "Known gaps".
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

  await forceAndReply(
    requestId,
    'CONTACT_RELEASED_QUESTION_CLIENT_2D',
    'Sí, dale, dale para adelante',
    'IN_PROGRESS',
  );
  await forceAndReply(
    requestId,
    'IN_PROGRESS_QUESTION_7D',
    // Deliberately avoids "listo": DetectResponseIntentUseCase resolves CONFIRMED keywords
    // before COMPLETED ones even though "listo" is in both lists, so a reply containing it
    // would be a no-op here instead of finishing the request (see generate-diverse-requests.ts).
    'Ya terminé el trabajo, quedó todo funcionando bien',
    'FINISHED',
  );
}
