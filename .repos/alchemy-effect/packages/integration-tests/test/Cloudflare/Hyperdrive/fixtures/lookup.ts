/**
 * Name of a Hyperdrive configuration the lookup tests create out-of-band
 * (directly through distilled, standing in for a dashboard-created config).
 * Per-user so concurrent runs on the shared test account don't collide.
 * Only read at deploy time — the deployed Worker addresses the binding by
 * the lookup id — so the runtime fallback is never used.
 */
export const lookupConfigName = (suite: "live" | "local") =>
  `alchemy-test-hd-lookup-${suite}-${(
    (typeof process === "undefined"
      ? undefined
      : (process.env.ALCHEMY_TEST_STAGE ?? process.env.USER)) ?? "ci"
  )
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")}`;
