import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Marker baked into the deployed code. The orchestrator GETs the worker URL
 * after each stage and asserts the live response carries the marker for the
 * stage it just deployed — proving the running code was actually replaced
 * in-place (not that a stale previous version is still serving).
 */
const MARKER = "04-beta.59";

// alchemy@2.0.0-beta.59 — the latest v2 release on npm (the `next` dist-tag;
// note `alchemy@latest` is the unrelated v1 line). State store version 7.
// Worker `main` still uses `import.meta.filename` at this release.
export default class CrossVersionWorker extends Cloudflare.Worker<CrossVersionWorker>()(
  "CrossVersionWorker",
  {
    // Fixed physical name so every stage targets the SAME Cloudflare worker
    // (deterministic in-place upgrade + a predictable workers.dev URL).
    name: "cross-version-test-worker",
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.json({
          marker: MARKER,
          alchemy: "2.0.0-beta.59",
          stateStoreVersion: 7,
        });
      }),
    };
  }),
) {}
