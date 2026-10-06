import fs from 'fs';
import path from 'path';
import { CLEANUP_ENDPOINT, TITLE_PREFIX } from './helpers/config';

/**
 * Calls specialist-be's dev-only cleanup endpoint to delete every `Request` (and
 * its cascaded Review/RequestInterest/RequestInteraction rows) whose title starts
 * with TITLE_PREFIX — i.e. everything this suite created.
 *
 * That endpoint does NOT exist yet as of this scaffold commit (see the
 * "specialist-e2e" plan, section 2 — dev-gated cleanup endpoint in specialist-be,
 * a separate stage of work). Until it lands, this call will 404 (or fail to
 * connect); that's expected and non-fatal — we warn loudly instead of failing the
 * whole test run, since the point of a teardown is to not mask real test
 * failures with an infra gap. Once the endpoint exists, this starts working with
 * no changes needed here.
 */
export default async function globalTeardown() {
  // Opt-out for when you want to inspect the data a run left behind (e.g. from the admin panel).
  const skipCleanup = ['1', 'true'].includes((process.env.E2E_SKIP_CLEANUP ?? '').toLowerCase());
  if (skipCleanup) {
    console.log('[global-teardown] E2E_SKIP_CLEANUP is set; leaving this run\'s data in the DB.');
    return;
  }

  const tokenPath = path.join(__dirname, '..', '.auth', 'admin-token.txt');
  let adminToken: string | undefined;
  try {
    adminToken = fs.readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    console.warn('[global-teardown] No admin token found from global-setup; skipping cleanup call.');
    return;
  }

  const url = `${CLEANUP_ENDPOINT}?titlePrefix=${encodeURIComponent(TITLE_PREFIX)}`;
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!res.ok) {
      console.warn(
        `[global-teardown] Cleanup endpoint not available yet (status ${res.status} from ${url}). ` +
          `See "specialist-e2e" plan section 2 — the dev-only cleanup endpoint in specialist-be hasn't ` +
          `been built yet. "${TITLE_PREFIX}"-tagged data from this run stays in the DB until it exists.`,
      );
      return;
    }
    const body = await res.json().catch(() => ({}));
    console.log(`[global-teardown] Cleanup succeeded: ${JSON.stringify(body)}`);
  } catch (err) {
    console.warn(
      `[global-teardown] Cleanup call to ${url} failed (${(err as Error).message}). ` +
        `See "specialist-e2e" plan section 2 — cleanup endpoint likely not built/running yet. ` +
        `"${TITLE_PREFIX}"-tagged data from this run stays in the DB until it exists.`,
    );
  }
}
