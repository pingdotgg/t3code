import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { environmentCatalogCommandScheduler } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { deregisterRelayEnvironment } from "./linkEnvironment";

export const deregisterEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:cloud:deregister-environment",
  scheduler: environmentCatalogCommandScheduler,
  concurrency: {
    mode: "serial",
    key: (_input: { readonly environmentId: EnvironmentId }) => "environment-catalog",
  },
  execute: (input) =>
    Effect.gen(function* () {
      yield* deregisterRelayEnvironment(input);

      const registry = yield* EnvironmentRegistry;
      const entries = yield* SubscriptionRef.get(registry.entries);
      if (!entries.has(input.environmentId)) return true;

      return yield* registry.remove(input.environmentId).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("Could not remove deregistered mobile environment.", {
            environmentId: input.environmentId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
    }),
});
