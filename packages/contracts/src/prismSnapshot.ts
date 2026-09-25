import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { RuntimeMode } from "./orchestration.ts";
import { PrismModelPreference, PrismThreadToolScope } from "./prism.ts";
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

/**
 * A role kit as the router reads it. Every role still carries
 * `lanes.easy/medium/hard` until the router reads single lists
 * (toolboxmd/model-router#127): a role other than the worker repeats its
 * one list, `models`, in every lane. Only Retry (`correction`) and
 * Escalation (`recovery`) carry `enabled`.
 */
const PrismSnapshotRoleKit = Schema.Struct({
  instructions: TrimmedString,
  runtimeMode: Schema.optionalKey(RuntimeMode),
  skills: Schema.Array(TrimmedNonEmptyString),
  threadTools: PrismThreadToolScope,
  lanes: Schema.Struct({
    easy: Schema.Array(PrismModelPreference),
    medium: Schema.Array(PrismModelPreference),
    hard: Schema.Array(PrismModelPreference),
  }),
  models: Schema.optionalKey(Schema.Array(PrismModelPreference)),
  enabled: Schema.optionalKey(Schema.Boolean),
});

export const PrismSnapshotRoles = Schema.Struct({
  planner: PrismSnapshotRoleKit,
  dispatcher: PrismSnapshotRoleKit,
  reviewer: PrismSnapshotRoleKit,
  worker: PrismSnapshotRoleKit,
  correction: PrismSnapshotRoleKit,
  recovery: PrismSnapshotRoleKit,
});
export type PrismSnapshotRoles = typeof PrismSnapshotRoles.Type;

export const PrismProviderSnapshot = Schema.Struct({
  generatedAt: IsoDateTime,
  /** The project the role kits were resolved for; null for environment values. */
  projectId: Schema.NullOr(ProjectId),
  providers: Schema.Array(PrismProviderSnapshotEntry),
  roles: PrismSnapshotRoles,
});
export type PrismProviderSnapshot = typeof PrismProviderSnapshot.Type;
