import type { SecretProviderConfigChoice, SecretProviderKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { SecretProviderDriver, SecretProviderDriverServices } from "./driver.ts";

export class SecretProviderConfigChoices extends Context.Service<
  SecretProviderConfigChoices,
  {
    /** Suggested values for a config field; empty for an unknown kind or a driver that cannot list. */
    readonly list: (
      kind: SecretProviderKind,
      field: string,
    ) => Effect.Effect<ReadonlyArray<SecretProviderConfigChoice>>;
  }
>()("@t3tools/secret-provider-core/server/SecretProviderConfigChoices") {}

export const make = Effect.fn("SecretProviderConfigChoices.make")(function* (options: {
  readonly drivers: ReadonlyArray<SecretProviderDriver>;
}) {
  const context = yield* Effect.context<SecretProviderDriverServices>();
  const driversByKind = new Map(options.drivers.map((driver) => [driver.kind, driver]));

  const list = Effect.fn("SecretProviderConfigChoices.list")(function* (
    kind: SecretProviderKind,
    field: string,
  ) {
    const listConfigChoices = driversByKind.get(kind)?.listConfigChoices;
    if (listConfigChoices === undefined) return [];
    return yield* listConfigChoices(field).pipe(Effect.provideContext(context));
  });

  return SecretProviderConfigChoices.of({ list });
});

export const layer = (options: Parameters<typeof make>[0]) =>
  Layer.effect(SecretProviderConfigChoices, make(options));
