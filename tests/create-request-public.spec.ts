import { test, expect } from '@playwright/test';
import path from 'path';
import { e2eTitle } from './helpers/config';

test.use({ storageState: path.join(__dirname, '..', '.auth', 'client.json') });

test('client creates a public request (solicitud pública)', async ({ page }) => {
  const title = e2eTitle('Solicitud publica');

  await page.goto('/es/client/requests/new');

  // Step 1: request type.
  await page.getByRole('button', { name: /p[uú]blica/i }).click();

  // Step 2: pick a trade by name — a generic "first button with text" selector
  // would match the "Volver" (back) button too, since it renders before the grid.
  await page.getByRole('heading', { name: 'Electricista', exact: true }).click();

  // Step 3: form fields.
  await page.locator('#title').fill(title);
  await page.locator('#description').fill('Descripcion generada por la suite E2E, minimo 10 caracteres.');
  await page.locator('#address').fill('Av. Bustillo 1000, Bariloche');

  await page.getByRole('button', { name: /crear|enviar|publicar|submit/i }).click();

  // Submitting without photos shows an optional confirmation modal (see TODO.md:
  // "modal opcional si se envía sin fotos") — confirm through it if it appears.
  const continueWithoutPhotos = page.getByRole('button', { name: /continuar sin fotos/i });
  if (await continueWithoutPhotos.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await continueWithoutPhotos.click();
  }

  // Success redirects to the client dashboard (not just any /client/requests* URL,
  // which would also match the still-open creation form).
  await expect(page).toHaveURL(/\/client\/dashboard/, { timeout: 15_000 });

  // The dashboard groups requests into tabs by whose turn it is to act. A
  // freshly published, unassigned public request has no interested specialist
  // yet, so it lands under "Esperando a la otra parte" (waiting on the other
  // side), not the default-selected "Te toca a vos" tab.
  await page.getByRole('tab', { name: /esperando a la otra parte/i }).click();
  await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 });
});
