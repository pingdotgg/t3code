import * as Cloudflare from "@/Cloudflare/index.ts";
import { Random } from "@/Random";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Binds an `Alchemy.Random` output into the worker the way an app consumes a
 * generated secret: the init phase binds `secret.text` (an Output of
 * `Redacted<string>`), and the fetch handler reads the accessor per event.
 *
 * The response reports what the runtime read actually produced, so the test
 * can assert deploy/dev parity: a correct provider resolves the accessor to
 * the minted hex secret; one that fails to materialize the output yields
 * `undefined` here (the beta.62 regression shape).
 */
export default class RandomEnvWorker extends Cloudflare.Worker<RandomEnvWorker>()(
  "RandomEnvWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const secret = yield* Random("RandomEnvSecret");
    const accessor = yield* secret.text;

    return {
      fetch: Effect.gen(function* () {
        const resolved = yield* accessor;
        const value = Redacted.isRedacted(resolved)
          ? Redacted.value(resolved)
          : resolved;
        return yield* HttpServerResponse.json({
          resolvedType: typeof value,
          isHexSecret:
            typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
        });
      }),
    };
  }),
) {}
