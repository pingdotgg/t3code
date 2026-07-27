import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Marker baked into the deployed code. The orchestrator GETs the worker URL
 * after each stage and asserts the live response carries the marker for the
 * stage it just deployed — proving the running code was actually replaced
 * in-place (not that a stale previous version is still serving).
 */
const MARKER = "05-current";

// Current branch — resolves `alchemy` from the monorepo workspace (the local
// source under packages/alchemy), NOT from npm. State store version 7.
// Worker `main` uses `import.meta.url` (the form HEAD expects — see #702).
export default class CrossVersionWorker extends Cloudflare.Worker<CrossVersionWorker>()(
  "CrossVersionWorker",
  {
    // Fixed physical name so every stage targets the SAME Cloudflare worker
    // (deterministic in-place upgrade + a predictable workers.dev URL).
    name: "cross-version-test-worker",
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.json({
          marker: MARKER,
          alchemy: "current",
          stateStoreVersion: 7,
        });
      }),
    };
  }),
) {}
