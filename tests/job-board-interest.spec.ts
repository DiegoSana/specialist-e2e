import { test, expect } from '@playwright/test';
import path from 'path';
import { e2eTitle } from './helpers/config';

const CLIENT_STATE = path.join(__dirname, '..', '.auth', 'client.json');
const PROFESSIONAL_STATE = path.join(__dirname, '..', '.auth', 'professional.json');

/**
 * Needs two independent sessions (client + professional) at once, so it drives its
 * own two BrowserContexts instead of relying on the project-level `storageState`.
 */
test('professional expresses and withdraws interest on a public request', async ({ browser }) => {
  const title = e2eTitle('Job board interes');

  const clientCtx = await browser.newContext({ storageState: CLIENT_STATE });
  const proCtx = await browser.newContext({ storageState: PROFESSIONAL_STATE });
  const clientPage = await clientCtx.newPage();
  const proPage = await proCtx.newPage();

  try {
    // Client creates a public request for the professional to find.
    await clientPage.goto('/es/client/requests/new');
    await clientPage.getByRole('button', { name: /p[uú]blica/i }).click();
    await clientPage.getByRole('heading', { name: 'Plomero', exact: true }).click();
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
    await expect(clientPage).toHaveURL(/\/client\/dashboard/, { timeout: 15_000 });

    // A freshly published, unassigned public request has no interested specialist yet, so it
    // lands under "Esperando a la otra parte" (waiting on the other side), not the
    // default-selected "Te toca a vos" tab (same fix as create-request-public.spec.ts). Capture
    // its id here so the later re-visit doesn't depend on finding it by title again.
    const waitingTab = clientPage.getByRole('tab', { name: /esperando a la otra parte/i });
    if (await waitingTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await waitingTab.click();
    }
    await clientPage.getByText(title).click();
    await expect(clientPage).toHaveURL(/\/client\/requests\/[0-9a-fA-F-]{8,}/, { timeout: 10_000 });
    const requestUrl = clientPage.url();
    const requestId = new URL(requestUrl).pathname.split('/').pop()!;

    // Professional: confirm the request is discoverable on the job board first (the card
    // shows the description, not the title, and description text isn't unique across runs
    // before the cleanup endpoint exists — see TODO.md — so there's no stable per-card
    // selector to click through on), then go straight to its detail page by id to express
    // interest deterministically.
    await proPage.goto('/es/specialist/job-board');
    await expect(proPage.getByRole('heading', { name: /bolsa de trabajo/i })).toBeVisible({
      timeout: 10_000,
    });

    await proPage.goto(`/es/specialist/requests/${requestId}`);
    await proPage.getByRole('button', { name: /me interesa|interesad[oa]|estoy interesado/i }).click();
    // Some surfaces reveal an optional message textarea + a separate "Confirmar interes"
    // step, others (this detail page, per a real run) toggle interest on the first click —
    // handle both without assuming either.
    const messageBox = proPage.locator('#interestMessage');
    if (await messageBox.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await messageBox.fill('Interes generado por la suite E2E.');
      await proPage.getByRole('button', { name: /confirmar inter[eé]s/i }).click();
    }
    await expect(proPage.getByRole('button', { name: /quitar inter[eé]s/i })).toBeVisible({
      timeout: 10_000,
    });

    // Client sees the professional in the interested list on their request detail.
    await clientPage.goto(requestUrl);
    await expect(clientPage.locator('[data-testid="interest-row"]')).toHaveCount(1, {
      timeout: 10_000,
    });

    // Professional withdraws interest.
    await proPage.getByRole('button', { name: /quitar inter[eé]s/i }).click();
    await expect(
      proPage.getByRole('button', { name: /me interesa|estoy interesado/i }),
    ).toBeVisible({
      timeout: 10_000,
    });

    // Client no longer sees them in the interested list.
    await clientPage.reload();
    await expect(clientPage.locator('[data-testid="interest-row"]')).toHaveCount(0, {
      timeout: 10_000,
    });
  } finally {
    await clientCtx.close();
    await proCtx.close();
  }
});
