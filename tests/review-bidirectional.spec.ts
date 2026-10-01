import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { e2eTitle, ADMIN_URL, FE_URL } from './helpers/config';
import { fastForwardRequestToFinished } from './helpers/fast-forward-request';
import { findRequestIdByTitle } from './helpers/requests';

const CLIENT_STATE = path.join(__dirname, '..', '.auth', 'client.json');
const PROFESSIONAL_STATE = path.join(__dirname, '..', '.auth', 'professional.json');
const ADMIN_STATE = path.join(__dirname, '..', '.auth', 'admin.json');

/**
 * Covers the bidirectional reviews redesign (REVIEWS_REDESIGN.md, merged 2026-09-30:
 * specialist-be PR #95, specialist-fe PR #40, specialist-admin PR #26) end to end: both
 * directions of a review on the same CLOSED request, admin moderating both (with the new
 * "Dirección" column), the doble-ciego-con-timeout reveal that only happens once BOTH are
 * APPROVED, and the admin "Destacar" (isFeatured) toggle.
 *
 * `review-moderation.spec.ts` stays a small single-direction smoke test (client reviews the
 * specialist, admin approves) -- this file is the full cross-direction flow, kept separate so a
 * failure here doesn't also take down the cheaper smoke test, and so the smoke test keeps
 * exercising the plain, pre-redesign-shaped happy path on its own.
 *
 * Runs under the `admin` Playwright project (see playwright.config.ts) like
 * review-moderation.spec.ts, for the same reason: the part actually under test (moderation) is
 * specialist-admin's, and specialist-fe is reached via absolute FE_URL navigations for setup.
 *
 * Uses a fresh, uniquely-titled request per run (e2eTitle) and embeds that unique title in both
 * review comments, so the admin table -- which shows reviewer/provider name and comment but not
 * the request title -- can still be scoped to *this* run's two rows even though the suite has no
 * cleanup endpoint yet and the Pending/Approved tabs can accumulate rows across runs (see
 * CLAUDE.md "Known gaps"). Matching rows by name alone (as the old review-moderation.spec.ts
 * does, safely, because it only ever creates one review) would be ambiguous here: the
 * professional (Miguel Torres) shows up as the Provider on the CLIENT_TO_PROVIDER row **and** as
 * the Reviewer on the PROVIDER_TO_CLIENT row for the same request.
 */
test('bidirectional reviews: both parties rate each other, admin moderates both, reveal after both approved, admin features a review', async ({
  browser,
}) => {
  // fastForwardRequestToFinished alone can take up to ~40s worst case (two WhatsApp follow-up
  // round-trips, each with up to a 20s poll) before any UI steps are counted, and this spec does
  // two full review submissions, two page reloads per direction to check the reveal gate, two
  // admin moderation actions and a tab switch + feature toggle on top. In practice this runs in
  // ~10s against a warm local stack, but budget generously above review-moderation.spec.ts's
  // single-review 90s since this does roughly twice the work end to end.
  test.setTimeout(150_000);

  const title = e2eTitle('Bidirectional review');
  const clientComment = `Comentario del cliente para ${title}`;
  const providerComment = `Comentario del especialista para ${title}`;

  const clientCtx = await browser.newContext({ storageState: CLIENT_STATE });
  const clientPage = await clientCtx.newPage();
  const providerCtx = await browser.newContext({ storageState: PROFESSIONAL_STATE });
  const providerPage = await providerCtx.newPage();
  const adminCtx = await browser.newContext({ storageState: ADMIN_STATE });
  const adminPage = await adminCtx.newPage();

  try {
    // 1. Client creates a direct request to the seed professional (UI, real flow) -- same
    // pattern as review-moderation.spec.ts.
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

    // 2. Fast-forward to FINISHED via API (setup, not under test).
    await fastForwardRequestToFinished({ requestId });

    // 3. Client confirms completion (FINISHED -> CLOSED) -- required before either direction can
    // be reviewed (canBeReviewed() === CLOSED, not FINISHED).
    await clientPage.goto(`${FE_URL}/es/client/requests/${requestId}`);
    clientPage.once('dialog', (dialog) => dialog.accept());
    await clientPage.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(clientPage.getByText('Dejar mi reseña')).toBeVisible({ timeout: 15_000 });

    // 4. Client leaves their review (CLIENT_TO_PROVIDER) from the UI (ReviewCtaCard).
    await submitReview(clientPage, clientComment);
    await expect(clientPage.getByText('¡Gracias por tu reseña!')).toBeVisible();

    // 5. Before the specialist has rated back: on the specialist's own request page, the
    // client's just-submitted review exists but its content must stay hidden (doble-ciego) --
    // ReceivedRatingCard renders the "pending" state, not the rating/comment.
    await providerPage.goto(`${FE_URL}/es/specialist/requests/${requestId}`);
    await expect(providerPage.getByText('Calificación recibida, todavía oculta')).toBeVisible({
      timeout: 15_000,
    });
    await expect(providerPage.getByText(clientComment)).toHaveCount(0);
    // The specialist's own CTA to rate the client is still the "not yet reviewed" prompt.
    await expect(providerPage.getByText('Dejar mi reseña')).toBeVisible();

    // 6. Specialist rates the client back (PROVIDER_TO_CLIENT) -- POST /requests/:id/rate-client,
    // now creating a moderated Review instead of writing the legacy flat clientRating fields.
    await submitReview(providerPage, providerComment);
    await expect(providerPage.getByText('¡Gracias por tu reseña!')).toBeVisible();

    // 7. Back on the client's page: the specialist's review now exists (PENDING) but, same
    // doble-ciego rule, its content must stay hidden from the client too, even though the client
    // already submitted their own side.
    await clientPage.reload();
    await expect(clientPage.getByText('Calificación recibida, todavía oculta')).toBeVisible({
      timeout: 15_000,
    });
    await expect(clientPage.getByText(providerComment)).toHaveCount(0);
    // The client's own review stays visible to them throughout.
    await expect(clientPage.getByText('¡Gracias por tu reseña!')).toBeVisible();

    // 8. Admin moderation: both reviews show up in the Pendientes tab (default) with the correct
    // "Dirección" column, scoped by the unique comment text embedded in each (see file doc
    // comment for why name-based matching alone is ambiguous here).
    await adminPage.goto(`${ADMIN_URL}/admin/reviews`);
    await expect(adminPage.getByRole('button', { name: 'Pendientes' })).toBeVisible({
      timeout: 15_000,
    });

    const clientReviewRow = adminPage.getByRole('row').filter({ hasText: clientComment });
    const providerReviewRow = adminPage.getByRole('row').filter({ hasText: providerComment });
    await expect(clientReviewRow).toBeVisible({ timeout: 15_000 });
    await expect(providerReviewRow).toBeVisible({ timeout: 15_000 });
    await expect(clientReviewRow).toContainText('Cliente → Especialista');
    await expect(providerReviewRow).toContainText('Especialista → Cliente');

    // Approve the client's review first -- doble-ciego must NOT reveal yet (only one side
    // approved so far).
    adminPage.once('dialog', (dialog) => dialog.accept());
    await clientReviewRow.getByRole('button', { name: 'Approve' }).click();
    await expect(clientReviewRow).toHaveCount(0, { timeout: 10_000 });

    await providerPage.reload();
    await expect(providerPage.getByText('Calificación recibida, todavía oculta')).toBeVisible({
      timeout: 15_000,
    });

    // Approve the specialist's review -- both directions are now APPROVED, which
    // ReviewService.approve reveals synchronously (no need to wait for the reveal cron / flag).
    adminPage.once('dialog', (dialog) => dialog.accept());
    await providerReviewRow.getByRole('button', { name: 'Approve' }).click();
    await expect(providerReviewRow).toHaveCount(0, { timeout: 10_000 });

    // 9. Reveal: each party can now see the counterpart's real rating/comment instead of the
    // pending placeholder.
    await providerPage.reload();
    await expect(providerPage.getByText('Calificación recibida, todavía oculta')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(providerPage.getByText(clientComment)).toBeVisible();

    await clientPage.reload();
    await expect(clientPage.getByText('Calificación recibida, todavía oculta')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(clientPage.getByText(providerComment)).toBeVisible();

    // 10. Nice-to-have: the client's aggregate rating (ClientReputationCard) is visible in the
    // specialist's view of the request now that at least one PROVIDER_TO_CLIENT review of this
    // client is approved. cliente1@test.com is a shared seed account reused across every run of
    // this suite (no cleanup endpoint yet), so totalReviews can't be asserted as an exact count
    // -- just that the aggregate section renders with a real, positive count.
    const reputationHeading = providerPage.getByText(/Reputación de .* como cliente/i);
    await expect(reputationHeading).toBeVisible({ timeout: 10_000 });
    // ClientReputationCard renders "4.5 (3 reseñas)" as a single text node (no trailing anchor:
    // the count sits inside parens, not at the string's end) -- match the whole "(N reseña(s))"
    // fragment instead of anchoring on a bare suffix.
    const reviewCountEl = providerPage.getByText(/\(\d+\s*rese[nñ]as?\)/i).first();
    await expect(reviewCountEl).toBeVisible({ timeout: 10_000 });
    const reviewCountText = await reviewCountEl.textContent();
    expect(reviewCountText).toBeTruthy();
    expect(Number(reviewCountText?.match(/\d+/)?.[0] ?? '0')).toBeGreaterThan(0);

    // 11. Admin "Destacar" toggle: move to the Aprobadas tab, feature the client's review, and
    // confirm the visual state flips (no confirm() dialog on this action, unlike approve/reject).
    await adminPage.getByRole('button', { name: 'Aprobadas' }).click();
    const approvedClientRow = adminPage.getByRole('row').filter({ hasText: clientComment });
    await expect(approvedClientRow).toBeVisible({ timeout: 15_000 });
    const destacarButton = approvedClientRow.getByRole('button', { name: /Destacar/ });
    await expect(destacarButton).toHaveText('☆ Destacar');

    await destacarButton.click();
    await expect(approvedClientRow.getByRole('button', { name: /Destacada/ })).toHaveText(
      '★ Destacada',
      { timeout: 10_000 },
    );
  } finally {
    await adminCtx.close();
    await providerCtx.close();
    await clientCtx.close();
  }
});

/**
 * Drives the shared `ReviewCtaCard` form (identical component both directions --
 * client-to-professional on the client's request page, professional-to-client on the
 * specialist's) from its initial "Dejar mi reseña" CTA through to submission. 5-star rating
 * widget is 5 plain unnamed `<button>`s scoped under the "Tu calificación" label (no
 * `role="radio"`, no `data-testid` -- see specialist-e2e/CLAUDE.md "Writing a new spec" gotchas).
 */
async function submitReview(page: Page, comment: string): Promise<void> {
  await page.getByRole('button', { name: 'Dejar mi reseña', exact: true }).click();
  const ratingRow = page
    .getByText('Tu calificación', { exact: false })
    .locator('xpath=following-sibling::*[1]');
  await ratingRow.getByRole('button').last().click();
  await page.getByRole('textbox').last().fill(comment);
  await page.getByRole('button', { name: 'Enviar reseña', exact: true }).click();
}
