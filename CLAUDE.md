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
needs to touch the `User` table itself.

```bash
npm install
npx playwright install chromium   # first time only
npm test              # everything
npm run test:fe       # specialist-fe specs only
npm run test:admin    # review-moderation.spec.ts (crosses into specialist-admin)
npm run typecheck
```

Env vars (see `.env.example`): `E2E_API_URL`, `E2E_FE_URL`, `E2E_ADMIN_URL`,
`E2E_CLEANUP_ENDPOINT`, `E2E_TITLE_PREFIX`.

## Layout

- `playwright.config.ts` — two `projects`: `fe` (baseURL `:3001`) and `admin` (baseURL `:3000`,
  only `review-moderation.spec.ts`, which reaches specialist-fe via absolute URLs for its setup
  steps instead of juggling two baseURLs in one file). `workers: 1` — specs share the small,
  fixed set of seed accounts, so serial execution avoids data races between them.
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
  `job-board-interest`, `review-moderation`, `whatsapp-followup`.

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
- Registration (a brand-new user, not a seed account) isn't covered — the suite deliberately
  reuses fixed seed accounts so the cleanup story stays simple (no `User` rows to clean up). A
  future registration spec would need to extend the cleanup endpoint to also filter by an email
  prefix.
