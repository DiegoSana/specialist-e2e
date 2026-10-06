# specialist-e2e

Playwright + TypeScript end-to-end suite covering core flows across `specialist-fe` (public web
app) and `specialist-admin` (internal admin portal), driven against their real local dev
instances. Fifth sibling repo of `/var/www/specialist/`; see the root `CLAUDE.md` there for the
overall project layout and conventions, and root `TODO.md` for this suite's known gaps.

## Running

Needs all three of these running locally first:

```bash
docker compose -f ../specialist-be/docker-compose.dev.yml up -d   # :5000, seeded DB
npm --prefix ../specialist-fe run dev                              # :3001
npm --prefix ../specialist-admin run dev                           # :3000
```

The suite assumes `specialist-be/prisma/seed.ts` has already run (`npm run db:seed` there) — it
authenticates as the fixed seed accounts (`cliente1@test.com`, `plomero@test.com`,
`admin@specialist.com`, all password `Test1234!`) rather than registering new users, so it never
needs to touch the `User` table itself. **One documented exception**: `password-reset.spec.ts`
registers a single disposable, timestamped throwaway user via the UI instead of reusing a seed
account — resetting a seed account's password would break every later spec in the same serial run
(`workers: 1`) that logs in as that account expecting its original password. It never touches a
seed account's password.

```bash
npm install
npx playwright install chromium   # first time only
npm test              # everything
npm run test:fe       # specialist-fe specs only
npm run test:admin    # review-moderation, review-bidirectional, whatsapp-followup (cross into specialist-admin)
npm run typecheck
```

Env vars (see `.env.example`): `E2E_API_URL`, `E2E_FE_URL`, `E2E_ADMIN_URL`,
`E2E_CLEANUP_ENDPOINT`, `E2E_TITLE_PREFIX`, `E2E_SKIP_CLEANUP` (`1`/`true` = el teardown no
borra la data del run, útil para inspeccionarla desde el admin).

## Layout

- `playwright.config.ts` — two `projects`: `fe` (baseURL `:3001`) and `admin` (baseURL `:3000`,
  `review-moderation.spec.ts` + `review-bidirectional.spec.ts` + `whatsapp-followup.spec.ts`,
  which reach specialist-fe via absolute URLs for their setup steps instead of juggling two
  baseURLs in one file). `workers: 1` — specs share the small, fixed set of seed accounts, so
  serial execution avoids data races between them.
- `tests/global-setup.ts` — logs in the fixed seed accounts via the real `/auth/login` API (no
  OAuth, no UI) and writes one Playwright `storageState` file per role under `.auth/` (gitignored):
  `client.json`/`professional.json` (specialist-fe, localStorage keys `token`/`user`) and
  `admin.json` (specialist-admin, localStorage key `admin_token` — different key, different
  origin). Also writes `.auth/admin-token.txt` for helpers that call specialist-be directly.
- `tests/global-teardown.ts` — calls the cleanup endpoint described below; see "Known gaps".
- `tests/helpers/config.ts` — env var defaults, `SEED_USERS`, `e2eTitle()` (prefixes every
  request title this suite creates with `[E2E]` so the cleanup endpoint can find them).
- `tests/helpers/requests.ts` — `findRequestIdByTitle` (looks up a just-created request's id via
  `GET /requests` instead of racing the dashboard's tabbed UI) and `providerAcceptsRequest`
  (the provider -- not the client -- PATCHes SENT -> CONTACT_RELEASED; the only status transition
  reachable by a direct PATCH). Shared by `review-moderation.spec.ts` and
  `whatsapp-followup.spec.ts`.
- `tests/helpers/whatsapp.ts` -- `forceFollowUpViaApi`/`getThread` (thin wrappers over the always-
  available `/admin/whatsapp/conversations/:id/*` endpoints -- `trigger-followup` works under any
  `WHATSAPP_PROVIDER`), and `simulateWhatsAppReply`, which simulates a client/provider WhatsApp
  reply by POSTing straight to the real webhook (`POST /api/webhooks/twilio`) instead of the
  dev-only `simulate-reply` endpoint. Verified against `specialist-be`'s own inbound-processing
  code that the webhook has **zero branch on `WHATSAPP_PROVIDER`** -- it's the same function
  `simulate-reply` wraps -- so this works identically under `local` or `twilio`, *as long as the
  outbound send that produced `twilioMessageSid`/`metadata.recipientPhone` actually succeeded*
  (only a successful send stores those two fields; nothing can ever match a failed one). Never
  assumes the `local-<uuid>` id format the local adapter happens to produce, so it stays correct
  if this ever points at a real Twilio-configured environment.
- `tests/helpers/fast-forward-request.ts` -- drives a direct Request from SENT to FINISHED purely
  via the API, for `review-moderation.spec.ts`'s setup step. Sequence verified against
  `specialist-be/test/scripts/seed-data/generate-diverse-requests.ts`. Built on top of
  `helpers/whatsapp.ts` -- forces each follow-up rule via the API and replies via the real webhook
  (see above), not the dev-only `simulate-reply`.
- `tests/*.spec.ts` -- one file per flow: `auth`, `create-request-public`, `create-request-direct`,
  `job-board-interest`, `review-moderation`, `review-bidirectional`, `whatsapp-followup`.
  `review-moderation.spec.ts` is a small single-direction (client-to-professional) moderation
  smoke test predating the 2026-09-30 bidirectional reviews redesign; `review-bidirectional.spec.ts`
  covers the full redesign (both directions on one request, the doble-ciego reveal gate that only
  fires once both sides are APPROVED, the admin "Dirección" column, the "Destacar" toggle) — see
  that file's doc comment and `/var/www/specialist/REVIEWS_REDESIGN.md`.

## Writing a new spec — real gotchas, not guesses

Every one of these cost a real debugging round (run → read the failure → fix → rerun) the first
time; skip that round next time.

- **No `data-testid` anywhere** in specialist-fe or specialist-admin. Don't guess selector text
  from memory, docs, or "what it probably says" — write the spec, run it against the real stack,
  and when it fails, read `test-results/<test-name>/error-context.md` (the accessibility snapshot
  Playwright captures on failure) or the attached screenshot for the *actual* button text/roles.
  Concrete traps already hit: the review button is "Dejar mi reseña", not "Dejar reseña"; the
  star-rating widget is 5 plain unnamed `<button>`s, not `role="radio"`; the "force follow-up"
  admin panel's rule picker is a bare `<select>` with no label association.
- **Freshly-created requests don't show up where you'd expect.** The client dashboard
  (`/client/dashboard`) groups requests into tabs ("Te toca a vos" / "Esperando a la otra parte" /
  "Cerrados") — a brand-new request (nobody's acted on it yet) lands under "Esperando a la otra
  parte", not the default-selected tab. Don't assume `getByText(title)` finds it without checking
  tab visibility first (see any `create-request-*.spec.ts` for the pattern).
- **Prefer looking up a just-created entity's id via a direct API call** (`findRequestIdByTitle` in
  `helpers/requests.ts`: `GET /requests`, filter by the unique `[E2E] ... <timestamp>` title) over
  racing the dashboard's tabbed UI for it. This matters more every month: with no cleanup endpoint
  yet, E2E data accumulates run over run, and a loose URL-regex assertion like
  `/\/client\/(dashboard|requests)/` can false-positive-match the *still-open* `/client/requests/new`
  form (which contains the substring "requests" too) before any real navigation happened — require
  a UUID segment (`requests\/[0-9a-fA-F-]{8,}`) instead.
- **The direct-request provider picker selects by exact person name** ("Miguel Torres"), not trade
  text ("Plomero") — its search input's placeholder ("Ej: Electricista, Plomero, Juan García...")
  doesn't match a naive `/buscar|search/i` selector either, so a search-then-click flow can silently
  never filter and click the wrong (first-in-list) provider instead. Skip the search box, click the
  exact name directly. The admin reviews table has the same trap in reverse: it shows the provider
  by **name**, not trade — `getByRole('row', { name: /plomero/i })` won't match a row showing
  "Miguel Torres".
- **`canBeReviewed()` requires `CLOSED`, not `FINISHED`** (specialist-be's `RequestEntity`) — after
  a request reaches `FINISHED` there's one more client-side "Confirmar" step (moves it to `CLOSED`)
  before the review UI appears at all.
- **To simulate a WhatsApp reply, POST to the real webhook** (`POST /api/webhooks/twilio`, see
  `helpers/whatsapp.ts`), never the dev-only `simulate-reply` admin endpoint — it only works under
  `WHATSAPP_PROVIDER=local` and this suite needs to keep working regardless of that setting.

## Known gaps

- **Cleanup endpoint doesn't exist yet.** `global-teardown.ts` calls
  `DELETE {E2E_CLEANUP_ENDPOINT}?titlePrefix=[E2E]` on specialist-be, wrapped in try/catch — until
  that dev-only endpoint is built there (see root `TODO.md`, Backend section), every run leaves
  its `[E2E]`-tagged Requests (and whatever cascades from them) in the DB. The teardown logs a
  clear warning rather than failing when it 404s.
- **`review-moderation.spec.ts` and `whatsapp-followup.spec.ts` need `WHATSAPP_PROVIDER=local`**
  on the target specialist-be -- but *not* for the reply-simulation step (that POSTs to the real
  `/api/webhooks/twilio`, which has zero branch on `WHATSAPP_PROVIDER`, see `helpers/whatsapp.ts`).
  It's the **outbound** send `trigger-followup` triggers that needs it: under a real provider
  (`twilio`) with no Twilio credentials configured (verified against exactly this dev instance),
  `sendMessage` throws synchronously ("Twilio client is not initialized"), and a failed send never
  stores `twilioMessageSid`/`recipientPhone` on the interaction -- so nothing downstream can ever
  match a simulated reply to it. Even with real Twilio credentials configured, sending to the seed
  users' fake phone numbers would still not be useful for an automated, repeatable test. All 8
  specs were verified green together against a real running stack with `WHATSAPP_PROVIDER=local`.
- **No `data-testid` convention** on the login, register, create-request, express-interest, or
  review-moderation forms in either specialist-fe or specialist-admin — specs select by `id`,
  visible text, or ARIA role instead. Fine for this suite's current size; worth reconsidering if
  it grows much further.
- **CI is not wired up.** A workflow can be added later, but checking out `specialist-be`/
  `specialist-fe`/`specialist-admin` (three separate private repos) from `specialist-e2e`'s own
  Actions run needs a Personal Access Token with access to all of them, which doesn't exist yet.
  Tracked in root `TODO.md`.
- Registration (a brand-new user, not a seed account) is only covered incidentally, as a setup
  step inside `password-reset.spec.ts` (see "Running" above for why that spec is a documented
  exception to the seed-accounts-only rule) — there's no standalone registration spec, and the
  suite still otherwise deliberately reuses fixed seed accounts so the cleanup story stays simple
  (no `User` rows to clean up for the rest of the suite). The disposable users
  `password-reset.spec.ts` creates are **not** cleaned up by the existing cleanup endpoint (it
  only filters by Request title prefix, not by email) — extending it to also filter by an email
  prefix would be needed to actually delete them.
- **Bidirectional reviews: two gaps deliberately left uncovered** by `review-bidirectional.spec.ts`
  (both out of scope per REVIEWS_REDESIGN.md's own "fuera de alcance" section, not forgotten):
  - The 14-day reveal timeout (`RevealReviewsJob`, `REVIEW_REVEAL_TIMEOUT_DAYS`) — not testable in
    E2E without manipulating wall-clock time or faking `createdAt`; the spec only exercises the
    "both APPROVED" synchronous reveal path (`ReviewService.approve`'s immediate-reveal branch).
  - Reviews of a `Company` provider (vs. `Professional`) — the fixed seed accounts
    (`SEED_USERS`/`prisma/seed.ts`) don't include a company account easy to drive through a full
    request lifecycle without adding new seed data, which the suite's seed-accounts-only convention
    rules out. The `provider-detail-modal.tsx` fix that makes reviews visible for `Company`
    providers (REVIEWS_REDESIGN.md 4.3) is exercised only by specialist-fe's own unit/component
    tests, not here.
