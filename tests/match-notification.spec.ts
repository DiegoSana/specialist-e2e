import { test, expect, request as pwRequest } from '@playwright/test';
import path from 'path';
import { e2eTitle, API_URL, SEED_USERS } from './helpers/config';
import { findRequestIdByTitle } from './helpers/requests';

const CLIENT_STATE = path.join(__dirname, '..', '.auth', 'client.json');

async function loginAs(email: string, password: string): Promise<string> {
  const ctx = await pwRequest.newContext();
  try {
    const res = await ctx.post(`${API_URL}/auth/login`, { data: { email, password } });
    if (!res.ok()) {
      throw new Error(`[match-notification] login as ${email} failed (${res.status()}): ${await res.text()}`);
    }
    const body = (await res.json()) as { accessToken: string };
    return body.accessToken;
  } finally {
    await ctx.dispose();
  }
}

async function setNotifyOnNewMatchingRequest(token: string, value: boolean): Promise<void> {
  const ctx = await pwRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  try {
    const res = await ctx.patch(`${API_URL}/professionals/me`, {
      data: { notifyOnNewMatchingRequest: value },
    });
    if (!res.ok()) {
      throw new Error(`[match-notification] PATCH /professionals/me failed (${res.status()}): ${await res.text()}`);
    }
  } finally {
    await ctx.dispose();
  }
}

interface NotificationDto {
  id: string;
  type: string;
  data: Record<string, unknown> | null;
}

async function getNotifications(token: string): Promise<NotificationDto[]> {
  const ctx = await pwRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  try {
    const res = await ctx.get(`${API_URL}/notifications`);
    if (!res.ok()) {
      throw new Error(`[match-notification] GET /notifications failed (${res.status()}): ${await res.text()}`);
    }
    return (await res.json()) as NotificationDto[];
  } finally {
    await ctx.dispose();
  }
}

/**
 * "Avisame cuando haya un pedido para mi": a professional opts in (PATCH /professionals/me
 * { notifyOnNewMatchingRequest: true }) to get an in-app notification when a new public Request
 * matching their trade is created. The accompanying WhatsApp send bypasses the generic dispatch
 * pipeline via a direct Twilio adapter call (see specialist-be's requests-notifications.handler.ts)
 * and can't be asserted here -- the in-app notification is sufficient signal.
 *
 * Opt-in and notification check go entirely via direct API calls (no FE UI toggle exists yet for
 * this). Triggering reuses job-board-interest.spec.ts's proven UI flow for creating the public
 * "Plomero" request.
 */
test('opted-in professional gets notified when a new matching public request is created', async ({ browser }) => {
  test.setTimeout(60_000);
  const title = e2eTitle('Match notification');
  const proToken = await loginAs(SEED_USERS.professional.email, SEED_USERS.professional.password);

  await setNotifyOnNewMatchingRequest(proToken, true);
  try {
    const clientCtx = await browser.newContext({ storageState: CLIENT_STATE });
    const clientPage = await clientCtx.newPage();
    try {
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

      // Look up the id via API instead of clicking through the dashboard's tabbed UI to find
      // it -- with accumulated E2E data (no cleanup endpoint yet) that race gets slower every
      // run and this test doesn't need to exercise that UI anyway. See helpers/requests.ts.
      const requestId = await findRequestIdByTitle(title);

      await expect
        .poll(
          async () => {
            const notifications = await getNotifications(proToken);
            return notifications.some(
              (n) => n.type === 'REQUEST_MATCHING_TRADE_CREATED' && n.data?.requestId === requestId,
            );
          },
          { timeout: 15_000, message: 'waiting for REQUEST_MATCHING_TRADE_CREATED notification' },
        )
        .toBe(true);
    } finally {
      await clientCtx.close();
    }
  } finally {
    await setNotifyOnNewMatchingRequest(proToken, false);
  }
});
