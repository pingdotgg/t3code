import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { RuntimeMode } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Prism (Model Router) roles and their kits (toolboxmd/model-router#115).
 *
 * A role is a kit (instructions, permissions, skills, thread-tool scope)
 * plus an ordered list of models; only the worker keeps one list per lane. The kits live in server
 * settings under `prismRoles`, overridable per project like any key in
 * `PROJECT_SCOPED_SERVER_SETTING_KEYS`. The router reads them from the
 * provider snapshot endpoint; `spawn_thread(role)` applies them directly.
 */
export const PRISM_ROLES = [
  "planner",
  "dispatcher",
  "reviewer",
  "worker",
  "correction",
  "recovery",
] as const;
export const PrismRole = Schema.Literals(PRISM_ROLES);
export type PrismRole = typeof PrismRole.Type;

/**
 * Which `threads` MCP tools a role's thread may use.
 * - `planner`: every thread tool with `project` scope, plus the Prism tools.
 * - `children`: read, list and message its own children only.
 * - `project-read`: read and list, with `project` scope; no spawn, no message.
 * - `none`: no thread tools.
 */
export const PrismThreadToolScope = Schema.Literals([
  "planner",
  "children",
  "project-read",
  "none",
]);
export type PrismThreadToolScope = typeof PrismThreadToolScope.Type;

const PRISM_DEFAULT_THREAD_TOOL_SCOPES: Record<PrismRole, PrismThreadToolScope> = {
  planner: "planner",
  dispatcher: "children",
  reviewer: "project-read",
  worker: "none",
  correction: "none",
  recovery: "none",
};

/** Work difficulty a job or spawn runs at; the worker keeps one model list per lane. */
const PRISM_LANES = ["easy", "medium", "hard"] as const;
export const PrismLane = Schema.Literals(PRISM_LANES);
export type PrismLane = typeof PrismLane.Type;
export const DEFAULT_PRISM_LANE: PrismLane = "medium";

/**
 * One entry of a role's model list. The same model at another effort is a
 * separate entry.
 */
export const PrismModelPreference = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  /** Claude effort, Codex/Grok reasoningEffort, OpenCode variant. */
  effort: Schema.optionalKey(TrimmedNonEmptyString),
});
export type PrismModelPreference = typeof PrismModelPreference.Type;

const modelList = Schema.Array(PrismModelPreference).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
);

export const PrismLaneModels = Schema.Struct({
  easy: modelList,
  medium: modelList,
  hard: modelList,
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type PrismLaneModels = typeof PrismLaneModels.Type;

/** Roles the user may switch off in Prism; the router then skips that step. */
export const PRISM_SWITCHABLE_ROLES = ["correction", "recovery"] as const;
export type PrismSwitchableRole = (typeof PRISM_SWITCHABLE_ROLES)[number];

/** Names shown to people. Keys stay stable because the router snapshot uses them. */
export const PRISM_ROLE_LABELS: Record<PrismRole, string> = {
  planner: "Planner",
  dispatcher: "Dispatcher",
  reviewer: "Reviewer",
  worker: "Worker",
  correction: "Retry",
  recovery: "Escalation",
};

/** Role names `spawn_thread` accepts: every key plus the shown names of renamed roles. */
export const PrismRoleName = Schema.Literals([...PRISM_ROLES, "retry", "escalation"]);
export type PrismRoleName = typeof PrismRoleName.Type;

export function prismRoleFromName(name: PrismRoleName): PrismRole {
  return name === "retry" ? "correction" : name === "escalation" ? "recovery" : name;
}

const kitFields = (role: PrismRole) => ({
  /** Prepended to the first message of every thread started in this role. */
  instructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Permissions; absent means the spawning thread's runtime mode. */
  runtimeMode: Schema.optionalKey(RuntimeMode),
  /** Skill names the role is told to use. */
  skills: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  threadTools: PrismThreadToolScope.pipe(
    Schema.withDecodingDefault(Effect.succeed(PRISM_DEFAULT_THREAD_TOOL_SCOPES[role])),
  ),
});

/**
 * The worker keeps one list per lane: the primary model first and fallbacks
 * after it. Eligible = these ∩ models enabled in Providers for the project
 * and environment.
 */
const workerKit = Schema.Struct({ ...kitFields("worker"), lanes: PrismLaneModels }).pipe(
  Schema.withDecodingDefault(Effect.succeed({})),
);

/**
 * Every other role keeps one ordered list. Settings saved before that kept
 * one list per lane; the medium list becomes the single list.
 */
const singleListKit = <Fields extends Schema.Struct.Fields>(role: PrismRole, extra: Fields) => {
  const kit = Schema.Struct({ ...kitFields(role), models: modelList, ...extra });
  return Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.decodeTo(
      kit,
      SchemaTransformation.transform({
        decode: ({ lanes, ...fields }) => {
          const legacy = (lanes as { medium?: unknown } | undefined)?.medium;
          return (
            fields.models === undefined && legacy !== undefined
              ? { ...fields, models: legacy }
              : fields
          ) as typeof kit.Encoded;
        },
        encode: (fields) => fields as Record<string, unknown>,
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed({})),
  );
};

const switchable = {
  /** Off: the router skips this step of its ladder. */
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
};

export const PrismRoleKits = Schema.Struct({
  planner: singleListKit("planner", {}),
  dispatcher: singleListKit("dispatcher", {}),
  reviewer: singleListKit("reviewer", {}),
  worker: workerKit,
  correction: singleListKit("correction", switchable),
  recovery: singleListKit("recovery", switchable),
});
export type PrismRoleKits = typeof PrismRoleKits.Type;
export type PrismRoleKit = PrismRoleKits[PrismRole];

export const DEFAULT_PRISM_ROLE_KITS: PrismRoleKits = Schema.decodeSync(PrismRoleKits)({});

/** The ordered list a spawn in `role` walks: the worker's lane, else the role's single list. */
export function prismRoleModels(
  kits: PrismRoleKits,
  role: PrismRole,
  lane: PrismLane,
): ReadonlyArray<PrismModelPreference> {
  return role === "worker" ? kits.worker.lanes[lane] : kits[role].models;
}

const kitPatchFields = {
  instructions: Schema.optionalKey(TrimmedString),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  skills: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  threadTools: Schema.optionalKey(PrismThreadToolScope),
};
const singleListKitPatch = Schema.Struct({
  ...kitPatchFields,
  models: Schema.optionalKey(Schema.Array(PrismModelPreference)),
});
const switchableKitPatch = Schema.Struct({
  ...singleListKitPatch.fields,
  enabled: Schema.optionalKey(Schema.Boolean),
});

/** Per-role, per-field, per-lane update; arrays (skills, a model list) replace whole. */
export const PrismRoleKitsPatch = Schema.Struct({
  planner: Schema.optionalKey(singleListKitPatch),
  dispatcher: Schema.optionalKey(singleListKitPatch),
  reviewer: Schema.optionalKey(singleListKitPatch),
  worker: Schema.optionalKey(
    Schema.Struct({
      ...kitPatchFields,
      lanes: Schema.optionalKey(
        Schema.Struct({
          easy: Schema.optionalKey(Schema.Array(PrismModelPreference)),
          medium: Schema.optionalKey(Schema.Array(PrismModelPreference)),
          hard: Schema.optionalKey(Schema.Array(PrismModelPreference)),
        }),
      ),
    }),
  ),
  correction: Schema.optionalKey(switchableKitPatch),
  recovery: Schema.optionalKey(switchableKitPatch),
});
export type PrismRoleKitsPatch = typeof PrismRoleKitsPatch.Type;
