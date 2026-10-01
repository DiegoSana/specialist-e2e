import { test, expect } from '@playwright/test';
import path from 'path';
import { e2eTitle, ADMIN_URL, FE_URL } from './helpers/config';
import { fastForwardRequestToFinished } from './helpers/fast-forward-request';
import { findRequestIdByTitle } from './helpers/requests';

const CLIENT_STATE = path.join(__dirname, '..', '.auth', 'client.json');
const ADMIN_STATE = path.join(__dirname, '..', '.auth', 'admin.json');

/**
 * Crosses specialist-fe (create request, leave review) and specialist-admin
 * (approve the pending review). Runs under the `admin` Playwright project (see
 * playwright.config.ts) but opens its own client-side context pointed at
 * E2E_FE_URL explicitly, since the admin project's baseURL is specialist-admin's
 * origin.
 *
 * Deliberately kept small: a single-direction (client-to-professional) smoke test of the
 * moderation happy path, predating the 2026-09-30 bidirectional reviews redesign
 * (REVIEWS_REDESIGN.md) but still valid under it -- CLIENT_TO_PROVIDER review creation and
 * moderation didn't change shape. For the full bidirectional flow (both directions, the
 * doble-ciego reveal gate, the "Dirección" column, the "Destacar" toggle), see
 * review-bidirectional.spec.ts instead.
 *
 * The admin row lookup below matches by provider name alone (`/Miguel Torres/i`), which is only
 * safe because this spec creates exactly one review for this request. review-bidirectional.spec.ts
 * creates two (one per direction) on the same request, where "Miguel Torres" appears as both
 * Provider (CLIENT_TO_PROVIDER row) and Reviewer (PROVIDER_TO_CLIENT row) -- see that file's doc
 * comment for why it scopes by comment text instead.
 *
 * Depends on the cleanup endpoint (specialist-be plan section 2, not built yet as
 * of this scaffold commit) to avoid leaving FINISHED requests + approved reviews
 * behind on every run — see global-teardown.ts.
 */
test('admin approves a pending review', async ({ browser }) => {
  // fastForwardRequestToFinished polls twice (CONTACT_RELEASED -> IN_PROGRESS -> FINISHED),
  // each via the WhatsApp follow-up simulation with up to a 20s wait -- comfortably exceeds
  // the 30s default on its own before any UI steps are counted.
  test.setTimeout(90_000);
  const title = e2eTitle('Review moderation');

  const clientCtx = await browser.newContext({ storageState: CLIENT_STATE });
  const clientPage = await clientCtx.newPage();

  try {
    // 1. Client creates a direct request to the seed professional (UI, real flow).
    await clientPage.goto(`${FE_URL}/es/client/requests/new`);
    await clientPage.getByRole('button', { name: /directa/i }).click();
    // Pick by name, not trade text — see create-request-direct.spec.ts for why.
    await clientPage.getByText('Miguel Torres', { exact: true }).click();
    await clientPage.locator('#title').fill(title);
    await clientPage
      .locator('#description')
      .fill('Descripcion generada por la suite E2E, minimo 10 caracteres.');
    await clientPage.locator('#address').fill('Av. Bustillo 1000, Bariloche');
    await clientPage.getByRole('button', { name: /crear|enviar|publicar|submit/i }).click();

    // Submitting without photos shows an optional confirmation modal — confirm through it
    // if it appears (see create-request-public.spec.ts for context).
    const continueWithoutPhotos = clientPage.getByRole('button', { name: /continuar sin fotos/i });
    if (await continueWithoutPhotos.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await continueWithoutPhotos.click();
    }
    // Smoke-check creation actually redirected away from the form — NOT the still-open
    // /client/requests/new page, which a looser "requests" match would also hit.
    await expect(clientPage).toHaveURL(/\/client\/(dashboard|requests\/[0-9a-fA-F-]{8,})/, {
      timeout: 15_000,
    });

    const requestId = await findRequestIdByTitle(title);

    // 2. Fast-forward to FINISHED via API (setup, not under test — see helper). The provider
    // (not the client) accepts, and IN_PROGRESS/FINISHED are only reachable via the WhatsApp
    // follow-up simulation, not a direct PATCH — see fast-forward-request.ts.
    await fastForwardRequestToFinished({ requestId });

    // 3. Client confirms completion (FINISHED -> CLOSED) -- canBeReviewed() requires CLOSED,
    // not FINISHED (specialist-be/src/requests/CLAUDE.md), so this step is required before a
    // review can be left. This is a direct FE control (client-side "Confirmar"), not the
    // WhatsApp question_satisfaction ladder step -- that's a separate, equally valid path to the
    // same transition, covered by whatsapp-followup.spec.ts instead.
    await clientPage.goto(`${FE_URL}/es/client/requests/${requestId}`);
    clientPage.once('dialog', (dialog) => dialog.accept());
    await clientPage.getByRole('button', { name: 'Confirmar', exact: true }).click();

    // 4. Client leaves a review from the UI.
    await clientPage.getByRole('button', { name: /rese[nñ]a|calificaci|calificar|review/i }).click();
    // Star rating widget: 5 unnamed plain <button>s (no role="radio"), scoped to the row right
    // after the "Tu calificación" label so `.last()` can't accidentally grab "Enviar reseña".
    const ratingRow = clientPage
      .getByText('Tu calificación', { exact: false })
      .locator('xpath=following-sibling::*[1]');
    await ratingRow.getByRole('button').last().click();
    const commentBox = clientPage.getByRole('textbox').last();
    await commentBox.fill('Excelente trabajo, generado por la suite E2E.');
    await clientPage.getByRole('button', { name: /enviar|publicar|submit/i }).click();

    // 5. Admin approves it in specialist-admin — separate context: a different
    // origin needs its own storageState (admin_token), the client context's
    // storageState only covers specialist-fe's origin.
    const adminCtx = await browser.newContext({ storageState: ADMIN_STATE });
    const adminPage = await adminCtx.newPage();
    await adminPage.goto(`${ADMIN_URL}/admin/reviews`);

    const row = adminPage.getByRole('row', { name: /Miguel Torres/i }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    adminPage.once('dialog', (dialog) => dialog.accept());
    await row.getByRole('button', { name: 'Approve' }).click();

    await expect(row).toHaveCount(0, { timeout: 10_000 });
    await adminCtx.close();
  } finally {
    await clientCtx.close();
  }
});
