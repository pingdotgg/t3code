import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { RuntimeMode } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Prism (Model Router) roles and their kits (toolboxmd/model-router#115).
 *
 * A role is a kit (instructions, permissions, skills, thread-tool scope)
 * plus, per lane, an ordered list of models. The kits live in server
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

/** Work difficulty a job or spawn runs at; each role keeps one model list per lane. */
const PRISM_LANES = ["easy", "medium", "hard"] as const;
export const PrismLane = Schema.Literals(PRISM_LANES);
export type PrismLane = typeof PrismLane.Type;
export const DEFAULT_PRISM_LANE: PrismLane = "medium";

/**
 * One entry of a (role, lane) list. The same model at another effort is a
 * separate entry.
 */
export const PrismModelPreference = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  /** Claude effort, Codex/Grok reasoningEffort, OpenCode variant. */
  effort: Schema.optionalKey(TrimmedNonEmptyString),
});
export type PrismModelPreference = typeof PrismModelPreference.Type;

const laneModels = Schema.Array(PrismModelPreference).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
);

export const PrismLaneModels = Schema.Struct({
  easy: laneModels,
  medium: laneModels,
  hard: laneModels,
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type PrismLaneModels = typeof PrismLaneModels.Type;

const prismRoleKit = (role: PrismRole) =>
  Schema.Struct({
    /** Prepended to the first message of every thread started in this role. */
    instructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    /** Permissions; absent means the spawning thread's runtime mode. */
    runtimeMode: Schema.optionalKey(RuntimeMode),
    /** Skill names the role is told to use. */
    skills: Schema.Array(TrimmedNonEmptyString).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
    threadTools: PrismThreadToolScope.pipe(
      Schema.withDecodingDefault(Effect.succeed(PRISM_DEFAULT_THREAD_TOOL_SCOPES[role])),
    ),
    /**
     * Per lane, the primary model first and fallbacks after it. Eligible =
     * these ∩ models enabled in Providers for the project and environment.
     */
    lanes: PrismLaneModels,
  }).pipe(Schema.withDecodingDefault(Effect.succeed({})));

export const PrismRoleKits = Schema.Struct({
  planner: prismRoleKit("planner"),
  dispatcher: prismRoleKit("dispatcher"),
  reviewer: prismRoleKit("reviewer"),
  worker: prismRoleKit("worker"),
  correction: prismRoleKit("correction"),
  recovery: prismRoleKit("recovery"),
});
export type PrismRoleKits = typeof PrismRoleKits.Type;
export type PrismRoleKit = PrismRoleKits[PrismRole];

export const DEFAULT_PRISM_ROLE_KITS: PrismRoleKits = Schema.decodeSync(PrismRoleKits)({});

const PrismRoleKitPatch = Schema.Struct({
  instructions: Schema.optionalKey(TrimmedString),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  skills: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  threadTools: Schema.optionalKey(PrismThreadToolScope),
  lanes: Schema.optionalKey(
    Schema.Struct({
      easy: Schema.optionalKey(Schema.Array(PrismModelPreference)),
      medium: Schema.optionalKey(Schema.Array(PrismModelPreference)),
      hard: Schema.optionalKey(Schema.Array(PrismModelPreference)),
    }),
  ),
});

/** Per-role, per-field, per-lane update; arrays (skills, a lane's list) replace whole. */
export const PrismRoleKitsPatch = Schema.Struct({
  planner: Schema.optionalKey(PrismRoleKitPatch),
  dispatcher: Schema.optionalKey(PrismRoleKitPatch),
  reviewer: Schema.optionalKey(PrismRoleKitPatch),
  worker: Schema.optionalKey(PrismRoleKitPatch),
  correction: Schema.optionalKey(PrismRoleKitPatch),
  recovery: Schema.optionalKey(PrismRoleKitPatch),
});
export type PrismRoleKitsPatch = typeof PrismRoleKitsPatch.Type;
