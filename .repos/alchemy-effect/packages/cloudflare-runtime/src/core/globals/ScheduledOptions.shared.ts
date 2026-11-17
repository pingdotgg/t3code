/**
 * Reserved entry-socket path that triggers the user worker's `scheduled()`
 * handler, mirroring Miniflare's `CorePaths.SCHEDULED`
 * (`workers-sdk/packages/miniflare/src/workers/core/constants.ts`).
 *
 * Query parameters (all optional, matching Miniflare's
 * `workers/core/scheduled.ts`):
 * - `cron` — the cron expression reported on `controller.cron`
 * - `time` — epoch milliseconds reported on `controller.scheduledTime`
 * - `format=json` — respond with the full `FetcherScheduledResult` JSON
 *   instead of the plain-text outcome
 */
export const PATH_SCHEDULED = "/cdn-cgi/local/scheduled";

/**
 * Miniflare's former `CorePaths.SCHEDULED`. Kept for tooling that still
 * triggers scheduled handlers there.
 */
export const PATH_SCHEDULED_HANDLER = "/cdn-cgi/handler/scheduled";

/**
 * Legacy Miniflare path for triggering scheduled handlers
 * (`CorePaths.LEGACY_SCHEDULED`). Kept for compatibility with older tooling.
 */
export const PATH_SCHEDULED_LEGACY = "/cdn-cgi/mf/scheduled";
