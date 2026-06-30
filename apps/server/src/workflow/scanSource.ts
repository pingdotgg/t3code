import * as Effect from "effect/Effect";
import type { WorkflowSourceConfig } from "@t3tools/contracts";
import type {
  ExternalWorkItem,
  WorkSourcePage,
  WorkSourceProvider,
  WorkSourceProviderError,
} from "./Services/WorkSourceProvider.ts";

// ---------------------------------------------------------------------------
// Locked tuning constants (do not change without the plan owner's sign-off).
// ---------------------------------------------------------------------------

// Hard ceiling on listPage round-trips per (board, source) per sweep tick.
// Bounds a single tick's network + memory; a source with more pages than this
// is scanned partially (scanCompleted=false).
export const MAX_PAGES_PER_SOURCE_TICK = 10;
// Hard ceiling on accumulated items per (board, source) per sweep tick.
//
// COMPLETENESS CAVEAT: each tick re-scans from the first page (no persisted
// pagination cursor), so the SAME leading <=MAX_ITEMS items are fetched each
// tick. An active board still converges — as those items are admitted/closed
// they drop out of the upstream open query, exposing the next batch. But a
// STATIC backlog larger than this cap that never resolves is only ever scanned
// up to the cap; the tail is not reached. Full coverage of a large static
// backlog needs a persisted continuation cursor (resume past the cap) plus a
// cross-tick accumulated seen-set so missing/orphan detection stays correct —
// deliberately deferred as a larger change. recordSuccess only advances the
// cadence anchor so a partial scan no longer re-hammers the provider every tick.
export const MAX_ITEMS_PER_SOURCE_TICK = 500;
// The committer takes the board locks + a transaction PER chunk and releases
// between chunks, so this bounds how long the board is locked at once.
export const MAX_DELTAS_PER_RECONCILE_CHUNK = 50;

// ---------------------------------------------------------------------------
// Pagination result
// ---------------------------------------------------------------------------

export interface ScanResult {
  readonly items: ReadonlyArray<ExternalWorkItem>;
  // scanCompleted is TRUE iff we reached a page with no nextPageToken AND
  // neither the page cap nor the item cap was hit. A cap hit while a
  // nextPageToken is still present means the scan is PARTIAL → the
  // completeness gate stays closed (no missing/orphan detection). NOTE: the
  // cadence anchor (last_full_run_at) IS still advanced on a partial scan so
  // the source respects its syncIntervalSec — see recordSuccess.
  readonly scanCompleted: boolean;
}

export const chunkArray = <A>(
  items: ReadonlyArray<A>,
  size: number,
): ReadonlyArray<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

// Paginate listPage up to the page/item caps. completeness gate:
// scanCompleted=true ONLY when a page arrives with no nextPageToken before
// either cap was hit. If we stop because of a cap while a token remains,
// scanCompleted=false.
export const scanSource = (
  provider: WorkSourceProvider,
  source: WorkflowSourceConfig,
  since: string | undefined,
): Effect.Effect<ScanResult, WorkSourceProviderError> =>
  Effect.gen(function* () {
    const items: Array<ExternalWorkItem> = [];
    let pageToken: string | undefined = undefined;
    let scanCompleted = false;
    for (let page = 0; page < MAX_PAGES_PER_SOURCE_TICK; page++) {
      const fetched: WorkSourcePage = yield* provider.listPage({
        connectionRef: source.connectionRef,
        selector: source.selector,
        ...(since === undefined ? {} : { since }),
        ...(pageToken === undefined ? {} : { pageToken }),
        pageSize: 100,
      });
      for (const it of fetched.items) {
        items.push(it);
      }
      if (fetched.nextPageToken === undefined) {
        // Reached the end of the list without hitting a cap → complete.
        scanCompleted = true;
        break;
      }
      // More pages remain. Stop early if the item cap is reached (partial).
      if (items.length >= MAX_ITEMS_PER_SOURCE_TICK) {
        scanCompleted = false;
        break;
      }
      pageToken = fetched.nextPageToken;
      // If this was the last allowed page and a token still remains, the
      // loop exits with scanCompleted still false (partial scan).
    }
    return { items, scanCompleted } satisfies ScanResult;
  });

// Human-readable summary of any provider error for the last_error column.
export const describeWorkSourceProviderError = (error: WorkSourceProviderError): string => {
  switch (error._tag) {
    case "WorkSourceRateLimitError":
      return `rate-limited (retryAfterMs=${error.retryAfterMs})`;
    case "WorkSourceAuthError":
      return `auth failed (connectionRef=${error.connectionRef})`;
    case "WorkSourceTransientError":
    case "WorkSourceConfigError":
      return `${error._tag}: ${error.message}`;
  }
};
