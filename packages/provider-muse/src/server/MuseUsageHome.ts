import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { createMuseSdkHostEffect } from "./sdk.ts";

export class MuseUsageHome extends Context.Service<
  MuseUsageHome,
  {
    readonly resolve: (input: {
      readonly binaryPath: string;
      readonly environment: NodeJS.ProcessEnv;
    }) => Effect.Effect<string | undefined>;
  }
>()("@t3tools/provider-muse/server/MuseUsageHome") {}

const make = Effect.gen(function* () {
  const cache = yield* Cache.makeWith(
    Effect.fn("MuseUsageHome.initialize")(function* (
      input: Parameters<MuseUsageHome["Service"]["resolve"]>[0],
    ) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* Effect.acquireRelease(
            createMuseSdkHostEffect({ ...input, readOnly: true, startupTimeoutMs: 5_000 }),
            (host) => Effect.tryPromise(() => host.close()).pipe(Effect.ignore),
            { interruptible: true },
          );
          return host.initializeResult.museHome;
        }),
      );
    }),
    {
      capacity: 32,
      // Retry unavailable installations, but keep resolved homes across scans.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value ? Duration.infinity : Duration.seconds(30),
    },
  );
  const resolve: MuseUsageHome["Service"]["resolve"] = Effect.fn("MuseUsageHome.resolve")(
    function* ({ binaryPath, environment }) {
      // Cache keys compare structurally. Omitted and undefined variables both
      // disappear from the child process environment and must share an entry.
      return yield* Cache.get(cache, {
        binaryPath,
        environment: Object.fromEntries(
          Object.entries(environment).filter(([, value]) => value !== undefined),
        ),
      }).pipe(Effect.orElseSucceed(() => undefined));
    },
  );
  return MuseUsageHome.of({ resolve });
});

export const layer = Layer.effect(MuseUsageHome, make);
