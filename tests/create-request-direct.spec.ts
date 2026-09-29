import { test, expect } from '@playwright/test';
import path from 'path';
import { e2eTitle, SEED_USERS } from './helpers/config';

test.use({ storageState: path.join(__dirname, '..', '.auth', 'client.json') });

test('client creates a direct request (solicitud directa) to a specific provider', async ({ page }) => {
  const title = e2eTitle('Solicitud directa');

  await page.goto('/es/client/requests/new');

  // Step 1: request type.
  await page.getByRole('button', { name: /directa/i }).click();

  // Step 2: pick the seed professional plomero@test.com by name ("Miguel Torres") — not by
  // trade text: the picker's search input placeholder ("Ej: Electricista, Plomero, Juan
  // García...") doesn't match a /buscar|search/i selector, so it was silently never filled,
  // and matching on the substring "plomero" hit "Fernando Gómez" (trades "Electricista,
  // Plomero") first in the unfiltered list, assigning the wrong provider entirely.
  await page.getByText('Miguel Torres', { exact: true }).click();

  // Step 3: form fields.
  await page.locator('#title').fill(title);
  await page.locator('#description').fill('Descripcion generada por la suite E2E, minimo 10 caracteres.');
  await page.locator('#address').fill('Av. Bustillo 1000, Bariloche');

  await page.getByRole('button', { name: /crear|enviar|publicar|submit/i }).click();

  // Submitting without photos shows an optional confirmation modal — confirm
  // through it if it appears (see create-request-public.spec.ts for context).
  const continueWithoutPhotos = page.getByRole('button', { name: /continuar sin fotos/i });
  if (await continueWithoutPhotos.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await continueWithoutPhotos.click();
  }

  await expect(page).toHaveURL(/\/client\/dashboard/, { timeout: 15_000 });
  // A freshly created direct request is waiting on the targeted provider to
  // respond — same "Esperando a la otra parte" tab as a fresh public request.
  await page.getByRole('tab', { name: /esperando a la otra parte/i }).click();
  await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 });
});
