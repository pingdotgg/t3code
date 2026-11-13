import type { SecretReference, SecretSourceCheckResult } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

export class SecretCheck extends Context.Service<
  SecretCheck,
  {
    /**
     * Reads one secret fresh for the Settings "check" button and never returns the value. A
     * readable secret also rebuilds the provider instances that read it, from that same read.
     */
    readonly check: (reference: SecretReference) => Effect.Effect<SecretSourceCheckResult>;
  }
>()("t3/secrets/SecretCheck") {}

const make = Effect.gen(function* () {
  const resolver = yield* SecretResolver.SecretResolver;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

  const check = Effect.fn("SecretCheck.check")(function* (reference: SecretReference) {
    const [value] = yield* resolver.read([reference], { fresh: true });
    if (value === undefined || value.trim() === "") {
      return {
        _tag: "Failed",
        detail: `Could not read this secret from "${yield* resolver.label(reference.provider)}". Check the provider's settings and that its store is unlocked.`,
      } as const;
    }
    yield* providerRegistry.applySecretAndRefresh(reference, value);
    return { _tag: "Resolved" } as const;
  });

  return SecretCheck.of({ check });
});

export const layer = Layer.effect(SecretCheck, make);
