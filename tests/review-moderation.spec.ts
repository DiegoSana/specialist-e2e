import { test, expect, request as pwRequest } from '@playwright/test';
import path from 'path';
import { e2eTitle, ADMIN_URL, FE_URL, API_URL, SEED_USERS } from './helpers/config';
import { fastForwardRequestToFinished } from './helpers/fast-forward-request';

const CLIENT_STATE = path.join(__dirname, '..', '.auth', 'client.json');
const ADMIN_STATE = path.join(__dirname, '..', '.auth', 'admin.json');

/**
 * Looks up the just-created request's id via the API instead of clicking through the
 * dashboard's tabbed UI to find it. With accumulated E2E data across runs (no cleanup endpoint
 * yet, see TODO.md) the dashboard can take longer to render/tab-switch than is worth racing
 * against in a test that isn't exercising that UI anyway — `GET /requests` (client's own,
 * newest first) is the stable source of truth for "did creation succeed, and what's its id".
 */
async function findRequestIdByTitle(title: string): Promise<string> {
  const ctx = await pwRequest.newContext();
  try {
    const loginRes = await ctx.post(`${API_URL}/auth/login`, { data: SEED_USERS.client });
    if (!loginRes.ok()) {
      throw new Error(`[review-moderation] client login failed (${loginRes.status()})`);
    }
    const { accessToken } = (await loginRes.json()) as { accessToken: string };
    const listRes = await ctx.get(`${API_URL}/requests`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const list = (await listRes.json()) as Array<{ id: string; title: string }>;
    const match = list.find((r) => r.title === title);
    if (!match) {
      throw new Error(`[review-moderation] request with title "${title}" not found via API`);
    }
    return match.id;
  } finally {
    await ctx.dispose();
  }
}

/**
 * Crosses specialist-fe (create request, leave review) and specialist-admin
 * (approve the pending review). Runs under the `admin` Playwright project (see
 * playwright.config.ts) but opens its own client-side context pointed at
 * E2E_FE_URL explicitly, since the admin project's baseURL is specialist-admin's
 * origin.
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

    // 3. Client leaves a review from the UI.
    await clientPage.goto(`${FE_URL}/es/client/requests/${requestId}`);
    await clientPage.getByRole('button', { name: /dejar rese[nñ]a|calificar|review/i }).click();
    // Star rating widget — no stable selector confirmed; click the 5th star-like control.
    await clientPage.getByRole('radio').last().click();
    const commentBox = clientPage.getByRole('textbox').last();
    await commentBox.fill('Excelente trabajo, generado por la suite E2E.');
    await clientPage.getByRole('button', { name: /enviar|publicar|submit/i }).click();

    // 4. Admin approves it in specialist-admin — separate context: a different
    // origin needs its own storageState (admin_token), the client context's
    // storageState only covers specialist-fe's origin.
    const adminCtx = await browser.newContext({ storageState: ADMIN_STATE });
    const adminPage = await adminCtx.newPage();
    await adminPage.goto(`${ADMIN_URL}/admin/reviews`);

    const row = adminPage.getByRole('row', { name: /plomero/i }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    adminPage.once('dialog', (dialog) => dialog.accept());
    await row.getByRole('button', { name: 'Approve' }).click();

    await expect(row).toHaveCount(0, { timeout: 10_000 });
    await adminCtx.close();
  } finally {
    await clientCtx.close();
  }
});
