import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { e2eTitle, FE_URL } from './helpers/config';
import { findRequestIdByTitle, providerAcceptsRequest } from './helpers/requests';
import {
  findSentInteraction,
  getThread,
  simulateWhatsAppReply,
  waitForRequestStatus,
  type WhatsAppInteraction,
} from './helpers/whatsapp';

const CLIENT_STATE = path.join(__dirname, '..', '.auth', 'client.json');
const ADMIN_STATE = path.join(__dirname, '..', '.auth', 'admin.json');

/**
 * Uses the real "Forzar seguimiento" panel on the admin thread page (not the API directly) —
 * exercising that panel is the point of this test. Only renders when
 * `availableFollowUpRules.length > 0`, independent of `devMode`/`WHATSAPP_PROVIDER` (unlike the
 * "Simular respuesta (dev mode)" panel, which this suite deliberately does NOT use — see
 * tests/helpers/whatsapp.ts for why the real webhook is used for replies instead).
 */
async function forceFollowUpViaUI(adminPage: Page, requestId: string, ruleName: string): Promise<void> {
  await adminPage.goto(`/admin/whatsapp/${requestId}`);
  await expect(adminPage.getByRole('heading', { name: 'Forzar seguimiento' })).toBeVisible({
    timeout: 10_000,
  });
  await adminPage.getByRole('combobox').selectOption({ label: ruleName });
  await adminPage.getByRole('button', { name: 'Forzar seguimiento ahora' }).click();
  await expect(
    adminPage.getByRole('button', { name: 'Forzar seguimiento ahora' }),
  ).toBeEnabled({ timeout: 10_000 });
}

/**
 * Force a rule via the UI, find the resulting outbound interaction via the admin API (the thread
 * DOM never shows the rule/template name — see tests/helpers/whatsapp.ts), simulate the
 * recipient's reply via the real webhook, and wait for the resulting status transition.
 */
async function forceRuleAndReply(params: {
  adminPage: Page;
  requestId: string;
  ruleName: string;
  replyBody: string;
  expectedStatus: string;
}): Promise<WhatsAppInteraction> {
  const { adminPage, requestId, ruleName, replyBody, expectedStatus } = params;
  await forceFollowUpViaUI(adminPage, requestId, ruleName);

  let interaction: WhatsAppInteraction | undefined;
  for (let attempt = 0; attempt < 10 && !interaction; attempt++) {
    const thread = await getThread(requestId);
    interaction = findSentInteraction(thread, ruleName);
    if (!interaction) await adminPage.waitForTimeout(500);
  }
  if (!interaction || !interaction.twilioMessageSid || !interaction.metadata?.recipientPhone) {
    throw new Error(
      `[whatsapp-followup] rule ${ruleName} produced no matchable SENT interaction on request ${requestId} ` +
        `(outbound send likely failed — check WHATSAPP_PROVIDER on the target specialist-be)`,
    );
  }

  await simulateWhatsAppReply({
    messageSid: interaction.twilioMessageSid,
    from: interaction.metadata.recipientPhone,
    body: replyBody,
  });
  await waitForRequestStatus(requestId, expectedStatus);
  return interaction;
}

/**
 * Full lifecycle of a request driven entirely by simulated WhatsApp replies — the admin forces
 * each follow-up via the real "Forzar seguimiento" UI panel, the client/provider's reply is
 * simulated by POSTing to the real Twilio webhook (provider-agnostic by construction, works
 * under WHATSAPP_PROVIDER=local or =twilio identically), and each resulting status transition +
 * confirmation message is verified via the API (the admin thread UI never surfaces the
 * rule/template name, only status/direction/timestamps — confirmed by exploration).
 *
 * Requires WHATSAPP_PROVIDER=local on the target specialist-be so the outbound sends this test
 * triggers don't attempt real Twilio calls to the fake seed phone numbers — see CLAUDE.md "Known
 * gaps". The reply-simulation half of this test does NOT have that requirement (the webhook is
 * provider-agnostic); only the outbound "Forzar seguimiento" send does.
 */
test('a request lifecycle driven entirely by simulated WhatsApp replies', async ({ browser }) => {
  // Three full force-followup + webhook-reply + status-poll cycles.
  test.setTimeout(120_000);
  const title = e2eTitle('WhatsApp followup');

  const clientCtx = await browser.newContext({ storageState: CLIENT_STATE });
  const clientPage = await clientCtx.newPage();
  const adminCtx = await browser.newContext({ storageState: ADMIN_STATE });
  const adminPage = await adminCtx.newPage();

  try {
    // 1. Client creates a direct request to the seed professional (UI, real flow — same pattern
    // proven in review-moderation.spec.ts, including picking the provider by exact name).
    await clientPage.goto(`${FE_URL}/es/client/requests/new`);
    await clientPage.getByRole('button', { name: /directa/i }).click();
    await clientPage.getByText('Miguel Torres', { exact: true }).click();
    await clientPage.locator('#title').fill(title);
    await clientPage
      .locator('#description')
      .fill('Descripcion generada por la suite E2E, minimo 10 caracteres.');
    await clientPage.locator('#address').fill('Av. Bustillo 1000, Bariloche');
    await clientPage.getByRole('button', { name: /crear|enviar|publicar|submit/i }).click();
    const continueWithoutPhotos = clientPage.getByRole('button', { name: /continuar sin fotos/i });
    if (await continueWithoutPhotos.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await continueWithoutPhotos.click();
    }
    await expect(clientPage).toHaveURL(/\/client\/(dashboard|requests\/[0-9a-fA-F-]{8,})/, {
      timeout: 15_000,
    });
    const requestId = await findRequestIdByTitle(title);

    // 2. Provider accepts (SENT -> CONTACT_RELEASED) — the only transition reachable by a
    // direct PATCH; everything past this point goes through WhatsApp.
    await providerAcceptsRequest(requestId);

    // 3-4. CONTACT_RELEASED -> IN_PROGRESS: admin forces the "agreement" question to the client
    // via the real UI panel; the client's reply is simulated via the real webhook.
    await forceRuleAndReply({
      adminPage,
      requestId,
      ruleName: 'CONTACT_RELEASED_QUESTION_CLIENT_2D',
      replyBody: 'Sí, dale, dale para adelante',
      expectedStatus: 'IN_PROGRESS',
    });
    let thread = await getThread(requestId);
    expect(thread.some((i) => i.messageTemplate === 'status_update_started')).toBe(true);

    // 5. IN_PROGRESS -> FINISHED: provider confirms the work is done.
    await forceRuleAndReply({
      adminPage,
      requestId,
      ruleName: 'IN_PROGRESS_QUESTION_7D',
      // Deliberately avoids "listo": DetectResponseIntentUseCase resolves CONFIRMED keywords
      // before COMPLETED ones even though "listo" is in both lists.
      replyBody: 'Ya terminé el trabajo, quedó todo funcionando bien',
      expectedStatus: 'FINISHED',
    });
    thread = await getThread(requestId);
    expect(thread.some((i) => i.messageTemplate === 'status_update_completed')).toBe(true);

    // 6. FINISHED -> CLOSED: client confirms satisfaction.
    await forceRuleAndReply({
      adminPage,
      requestId,
      ruleName: 'FINISHED_QUESTION_0D',
      replyBody: 'Sí, quedé muy conforme, gracias',
      expectedStatus: 'CLOSED',
    });
    thread = await getThread(requestId);
    expect(thread.some((i) => i.messageTemplate === 'status_update_closed')).toBe(true);

    // 7. Final sanity: a real back-and-forth conversation happened (3 outbound follow-ups + 3
    // confirmations, at minimum), and it's discoverable from the admin conversations list — a
    // freshly created request with zero interactions doesn't appear there at all, so this check
    // only makes sense now, after the ladder ran.
    expect(thread.length).toBeGreaterThanOrEqual(6);
    await adminPage.goto('/admin/whatsapp');
    await expect(adminPage.getByRole('heading', { name: 'WhatsApp' })).toBeVisible({ timeout: 10_000 });
    await expect(adminPage.getByRole('link', { name: title })).toBeVisible({ timeout: 10_000 });
  } finally {
    await clientCtx.close();
    await adminCtx.close();
  }
});
