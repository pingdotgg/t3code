import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionAtomRuntime } from "../../connection/runtime";
import { archiveCloudComposerDrafts } from "../../state/use-composer-drafts";

export const removeCloudEnvironments = createRuntimeCommand(connectionAtomRuntime, {
  label: "cloud:preserve-drafts-and-remove-environments",
  execute: Effect.fn(function* (accountId: string | null) {
    const registry = yield* EnvironmentRegistry;
    const entries = yield* SubscriptionRef.get(registry.entries);
    const environmentIds = new Set(
      [...entries.values()]
        .filter((entry) => entry.target._tag === "RelayConnectionTarget")
        .map((entry) => entry.target.environmentId),
    );
    // Credentials are already revoked. A failed backup must leave the local
    // owners intact so a later sign-in can retry without losing their files.
    yield* Effect.tryPromise(() => archiveCloudComposerDrafts(accountId, environmentIds));
    yield* registry.removeRelayEnvironments();
  }),
});
