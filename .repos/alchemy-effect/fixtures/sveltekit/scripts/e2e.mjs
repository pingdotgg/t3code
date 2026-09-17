// The live suite's worker performs per-request `caches.default` lookups,
// which miniflare implements via loopback connections to its Node-side blob
// store. On the small Windows CI runner the job's cumulative socket churn
// (chromium + workerd + miniflare loopback; TIME_WAIT is ~2 minutes there)
// exhausts AFD buffer space by the time this suite runs — workerd fails with
// `bind(): WSAENOBUFS` / `ConnectEx(): ERROR_DUP_NAME` and SSR requests 500.
// cloudflare-runtime's own contributions were fixed (bounded retries,
// keep-alive loopback servers, no unspecified connect targets); the residual
// churn is outside this repo. Skip on Windows CI only.
//
// Re-validated 2026-08-04 with two controlled CI experiments on the
// test/sveltekit-windows-ungate branch: (1) running this fixture ISOLATED
// (nothing before it) still fails 11/26 with `bind(0.0.0.0:0)` WSAENOBUFS;
// (2) widening the dynamic port range to 64k (`netsh int ipv4 set
// dynamicport tcp start=1025 num=64510`, verified applied) does not help —
// the exhaustion is kernel buffer space (AFD/nonpaged pool), not the
// ephemeral-port range. This is a runner-capacity limitation, not a bug
// this repo can fix; the next lever would be connection reuse inside
// miniflare's loopback blob-store client (upstream).
import { execSync } from "node:child_process";

if (process.platform === "win32" && process.env.CI) {
  console.log(
    "fixtures/sveltekit e2e skipped on Windows CI: runner-level socket exhaustion (see scripts/e2e.mjs).",
  );
  process.exit(0);
}

// `bun run` puts the fixture's node_modules/.bin on PATH for playwright.
execSync("bun run test:e2e", { stdio: "inherit" });
