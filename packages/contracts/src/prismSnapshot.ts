import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PrismRoleKits } from "./prism.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderUsageLimits } from "./providerUsageLimits.ts";
import { ServerProviderModel, ServerProviderState } from "./server.ts";

/**
 * What `GET /api/prism/snapshot` returns to the Prism router: every provider
 * instance with its models and usage windows, plus the role kits resolved for
 * the requested project. Kept apart from `prism.ts` because `settings.ts`
 * imports the kits and `server.ts` imports `settings.ts`.
 */

/** One provider instance as the router needs it: models, options, usage windows. */
export const PrismProviderSnapshotEntry = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  status: ServerProviderState,
  /** Models this instance offers; `capabilities` carries the option descriptors. */
  models: Schema.Array(ServerProviderModel),
  /** Usage windows with `usedPercent` and `resetsAt`; absent when the driver reports none. */
  usageLimits: Schema.optional(ServerProviderUsageLimits),
});
export type PrismProviderSnapshotEntry = typeof PrismProviderSnapshotEntry.Type;

export const PrismProviderSnapshot = Schema.Struct({
  generatedAt: IsoDateTime,
  /** The project the role kits were resolved for; null for environment values. */
  projectId: Schema.NullOr(ProjectId),
  providers: Schema.Array(PrismProviderSnapshotEntry),
  roles: PrismRoleKits,
});
export type PrismProviderSnapshot = typeof PrismProviderSnapshot.Type;
