import * as Cloudflare from "@/Cloudflare";
import type { RuntimeContext } from "@/index";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * A DO-hosting Effect Worker whose `DEPLOY_N` env var is read from a mutable
 * module variable at plan time, so consecutive deploys can force a
 * structural-signature change — and therefore an instance replacement —
 * without editing any source file. The props Effect resolves in the engine
 * (test) process; the resulting plain string is what crosses the RPC
 * boundary to the dev sidecar.
 */
let deployN = "0";
export const setDeployN = (n: string) => {
  deployN = n;
};

export class HandoffObject extends Cloudflare.DurableObject<
  HandoffObject,
  {
    ping: () => Effect.Effect<string, never, RuntimeContext>;
  }
>()("HandoffObject") {}

export const HandoffObjectLive = HandoffObject.make(
  Effect.gen(function* () {
    return Effect.gen(function* () {
      return {
        ping: () => Effect.succeed("pong"),
      };
    });
  }),
);

export class HandoffWorker extends Cloudflare.Worker<
  HandoffWorker,
  {},
  HandoffObject
>()("HandoffWorker") {}

export default HandoffWorker.make(
  Effect.sync(() => ({
    main: import.meta.url,
    env: {
      DEPLOY_N: deployN,
    },
  })),
  Effect.gen(function* () {
    const objects = yield* HandoffObject;
    return {
      fetch: Effect.gen(function* () {
        const env = yield* Cloudflare.Workers.WorkerEnvironment;
        const pong = yield* objects.getByName("test").ping();
        return yield* HttpServerResponse.json({
          deploy: String(env.DEPLOY_N),
          pong,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json(
            { error: Cause.pretty(cause) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(HandoffObjectLive)),
);
