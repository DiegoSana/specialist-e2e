# specialist-e2e

Playwright E2E suite for the Specialist project — core flows across `specialist-fe` and
`specialist-admin`. See [`CLAUDE.md`](./CLAUDE.md) for how to run it, the repo layout, and known
gaps (cleanup endpoint not built yet, CI not wired up, `WHATSAPP_PROVIDER=local` precondition for
`review-moderation.spec.ts`).

```bash
npm install
npx playwright install chromium
npm test
```
