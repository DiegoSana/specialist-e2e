import { test, expect } from '@playwright/test';
import { SEED_USERS } from './helpers/config';

/**
 * Tests the login form itself (email/password path — no OAuth, see
 * specialist-fe/app/[locale]/login/page.tsx). Runs with a clean, unauthenticated
 * context (no storageState), unlike the other specs.
 */
test.describe('login', () => {
  test('logs in with valid seed credentials and reaches an authenticated page', async ({ page }) => {
    await page.goto('/es/login');
    await page.locator('#email').fill(SEED_USERS.client.email);
    await page.locator('#password').fill(SEED_USERS.client.password);
    await page.getByRole('button', { name: /iniciar sesi[oó]n|sign in|log in/i }).click();

    await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
    // A logged-in client lands somewhere under /client or /profile-setup (first login
    // ever); either way it must not be the login page and must not show a login form.
    await expect(page.locator('#email')).toHaveCount(0);
  });

  test('shows an error for invalid credentials', async ({ page }) => {
    await page.goto('/es/login');
    await page.locator('#email').fill(SEED_USERS.client.email);
    await page.locator('#password').fill('wrong-password-123');
    await page.getByRole('button', { name: /iniciar sesi[oó]n|sign in|log in/i }).click();

    await expect(page.getByText(/incorrect|inv[aá]lid|error/i)).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test('logs out and returns to an unauthenticated state', async ({ page }) => {
    await page.goto('/es/login');
    await page.locator('#email').fill(SEED_USERS.client.email);
    await page.locator('#password').fill(SEED_USERS.client.password);
    await page.getByRole('button', { name: /iniciar sesi[oó]n|sign in|log in/i }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });

    // Logout lives behind the user-menu dropdown (button shows the user's name),
    // not a top-level button — open it first.
    await page.getByRole('button', { name: /Juan Pérez/i }).click();
    await page.getByRole('button', { name: /cerrar sesi[oó]n|log ?out|sign out/i }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});
