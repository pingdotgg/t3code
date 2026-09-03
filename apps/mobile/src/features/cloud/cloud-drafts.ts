import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionAtomRuntime } from "../../connection/runtime";
import { archiveCloudComposerDrafts } from "../../state/use-composer-drafts";

export class CloudDraftArchiveError extends Schema.TaggedErrorClass<CloudDraftArchiveError>()(
  "CloudDraftArchiveError",
  {
    environmentCount: Schema.Number,
    hasAccountId: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not preserve local drafts for ${this.environmentCount} cloud environments before sign-out.`;
  }
}

export const removeCloudEnvironments = createRuntimeCommand(connectionAtomRuntime, {
  label: "cloud:preserve-drafts-and-remove-environments",
  execute: Effect.fn("removeCloudEnvironments")(function* (accountId: string | null) {
    const registry = yield* EnvironmentRegistry;
    const entries = yield* SubscriptionRef.get(registry.entries);
    const environmentIds = new Set(
      [...entries.values()]
        .filter((entry) => entry.target._tag === "RelayConnectionTarget")
        .map((entry) => entry.target.environmentId),
    );
    // Credentials are already revoked. A failed backup must leave the local
    // owners intact so a later sign-in can retry without losing their files.
    yield* Effect.tryPromise({
      try: () => archiveCloudComposerDrafts(accountId, environmentIds),
      catch: (cause) =>
        new CloudDraftArchiveError({
          environmentCount: environmentIds.size,
          hasAccountId: accountId !== null,
          cause,
        }),
    });
    yield* registry.removeRelayEnvironments();
  }),
});
