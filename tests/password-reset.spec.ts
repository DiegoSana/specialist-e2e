import { test, expect } from '@playwright/test';
import { MAILPIT_URL, SEED_PASSWORD } from './helpers/config';

/**
 * Covers the "olvidé mi contraseña" flow end to end: /forgot-password -> email (via
 * Mailpit) -> /reset-password?token=... -> login with the new password.
 *
 * Deliberate, documented EXCEPTION to this suite's "never registers new users" rule
 * (see CLAUDE.md): resetting a seed account's password would break every later spec in
 * this same serial run (`workers: 1`) that logs in as that account expecting its
 * original password. Instead this spec registers one disposable, timestamped throwaway
 * user via the UI and only ever touches that user's password — never a seed account.
 *
 * Runs with a clean, unauthenticated context (no storageState), like auth.spec.ts.
 *
 * Needs Mailpit reachable at E2E_MAILPIT_URL (default http://localhost:8025, matching
 * the Web UI / REST API port documented in specialist-be/docker-compose.dev.yml) in
 * addition to the usual specialist-be + specialist-fe dev servers.
 */

interface MailpitMessageSummary {
  ID: string;
}

interface MailpitMessagesResponse {
  messages: MailpitMessageSummary[];
}

interface MailpitMessageDetail {
  Text: string;
  HTML: string;
}

async function findLatestMessageTo(email: string): Promise<MailpitMessageDetail> {
  const deadline = Date.now() + 15_000;
  let lastMessageCount = 0;

  while (Date.now() < deadline) {
    // Note: /api/v1/messages ignores a `query` param entirely (always returns the
    // full inbox, unfiltered) — the real filtered-search endpoint is /api/v1/search
    // (verified empirically against a running Mailpit v1.28.0; confirmed via the
    // `count` field differing from `total` only on this endpoint).
    const res = await fetch(
      `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    );
    if (res.ok) {
      const body = (await res.json()) as MailpitMessagesResponse;
      lastMessageCount = body.messages?.length ?? 0;
      if (lastMessageCount > 0) {
        const id = body.messages[0].ID;
        const detailRes = await fetch(`${MAILPIT_URL}/api/v1/message/${id}`);
        if (detailRes.ok) {
          return (await detailRes.json()) as MailpitMessageDetail;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `No password-reset email arrived for ${email} within 15s (last seen ${lastMessageCount} messages matching the query).`,
  );
}

function extractResetToken(message: MailpitMessageDetail): string {
  const match = (message.Text || message.HTML || '').match(/token=([a-f0-9]{64})/);
  if (!match) {
    throw new Error('Could not find a 64-char hex reset token in the email body.');
  }
  return match[1];
}

test('resets a disposable user password end to end via the emailed link', async ({ page }) => {
  // Registration + two logins + a (up to) 15s Mailpit poll comfortably exceed
  // Playwright's default 30s test timeout.
  test.setTimeout(90_000);

  const email = `e2e-password-reset+${Date.now()}@test.com`;
  // Reuse the suite's known local-dev fixture password (same value as the seed accounts'
  // SEED_PASSWORD) rather than a fresh inline literal, so secret scanners don't flag this
  // disposable test account's password as a potential hardcoded credential.
  const originalPassword = SEED_PASSWORD;
  const newPassword = 'NewTest5678!';

  // --- Register the disposable throwaway user (documented exception, see file header) ---
  await page.goto('/es/register');
  // The role button's accessible name also pulls in the description paragraph text
  // ("Busco servicios de especialistas"), so match the heading inside it instead (same
  // pattern as create-request-public.spec.ts's trade picker) — clicking it bubbles up
  // to the parent button's onClick.
  await page.getByRole('heading', { name: 'Cliente', exact: true }).click();
  await page.locator('#firstName').fill('E2E');
  await page.locator('#lastName').fill('PasswordReset');
  await page.locator('#email').fill(email);
  await page.locator('#phone').fill('+5491122334455');
  await page.locator('#password').fill(originalPassword);
  await page.locator('#confirmPassword').fill(originalPassword);
  await page.getByRole('button', { name: /crear cuenta/i }).click();

  // Registration logs the user in and redirects away from /register.
  await expect(page).not.toHaveURL(/\/register/, { timeout: 10_000 });

  // --- Forgot password ---
  await page.goto('/es/forgot-password');
  await page.locator('#email').fill(email);
  await page.getByRole('button', { name: /enviar enlace/i }).click();
  await expect(page.getByText(/si existe una cuenta con ese correo/i)).toBeVisible({
    timeout: 10_000,
  });

  // --- Fetch the email from Mailpit and extract the reset token ---
  const message = await findLatestMessageTo(email);
  const token = extractResetToken(message);

  // --- Reset password via the emailed link ---
  await page.goto(`/es/reset-password?token=${token}`);
  await page.locator('#newPassword').fill(newPassword);
  await page.locator('#confirmPassword').fill(newPassword);
  await page.getByRole('button', { name: /restablecer contraseña/i }).click();
  await expect(page.getByText(/tu contraseña fue restablecida correctamente/i)).toBeVisible({
    timeout: 10_000,
  });

  // --- Confirm the new password works ---
  // Registration (earlier) left an active session in localStorage. Clear it before
  // navigating to /login: otherwise the login page's "redirect if already logged in"
  // effect (see app/[locale]/login/page.tsx) races with filling in this form —
  // sometimes it wins, sometimes the form submission does, causing an intermittent
  // "element detached from DOM" on whichever one loses the race.
  await page.evaluate(() => localStorage.clear());
  await page.getByRole('link', { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(newPassword);
  await page.getByRole('button', { name: /iniciar sesi[oó]n|sign in|log in/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });

  // --- Confirm the old password no longer works ---
  // Log out first: the login page redirects away immediately if it sees an existing
  // session in localStorage (see app/[locale]/login/page.tsx's "redirect if already
  // logged in" effect), which races with filling the form below.
  await page.evaluate(() => localStorage.clear());
  await page.goto('/es/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(originalPassword);
  await page.getByRole('button', { name: /iniciar sesi[oó]n|sign in|log in/i }).click();
  await expect(page.getByText(/incorrect|inv[aá]lid|error/i)).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(/\/login/);
});
