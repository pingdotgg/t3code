/**
 * Behavior ported from upstream `main` before a `@cloudflare/vite-plugin`
 * release ships it. The differential tests ignore these until the installed
 * release catches up; delete an entry once it does.
 */

/** `cloudflare:durable-objects` (`retryable()`), cloudflare/workers-sdk#16452. */
export const AHEAD_OF_RELEASE_BUILT_IN_MODULES: ReadonlyArray<string> = [
  "cloudflare:durable-objects",
];
