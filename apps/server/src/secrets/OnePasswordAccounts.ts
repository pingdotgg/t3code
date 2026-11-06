import type { OnePasswordAccountSummary } from "@t3tools/contracts";
import * as OnePasswordDriver from "@t3tools/secret-provider-onepassword/server/driver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

export class OnePasswordAccounts extends Context.Service<
  OnePasswordAccounts,
  {
    /** Signed-in accounts on this server; empty when `op` cannot answer. */
    readonly list: Effect.Effect<ReadonlyArray<OnePasswordAccountSummary>>;
  }
>()("t3/secrets/OnePasswordAccounts") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return OnePasswordAccounts.of({
    list: OnePasswordDriver.listAccounts().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ),
  });
});

export const layer = Layer.effect(OnePasswordAccounts, make);
