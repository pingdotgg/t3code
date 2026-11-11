import * as Schema from "effect/Schema";

import {
  AuthAccessReadScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  type AuthGrantScope,
  type AuthMcpClientAccess,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
} from "./auth.ts";
import { EnvironmentId, MessageId, ProjectId, RunId, ThreadId } from "./baseSchemas.ts";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import type { TailnetDeviceAccess } from "./tailnetDevices.ts";

export class McpGatewayUnavailableError extends Schema.TaggedError<McpGatewayUnavailableError>()(
  "McpGatewayUnavailableError",
  { message: Schema.String },
) {}

export const GATEWAY_SCOPE_VALUES = [
  "read",
  "create",
  "send",
  "control",
  "lifecycle",
  "approval",
  "artifact",
  "review",
  "admin",
  "delivery",
] as const;
export const GatewayScope = Schema.Literals(GATEWAY_SCOPE_VALUES);
export type GatewayScope = typeof GatewayScope.Type;

const APP_READ_SCOPES: ReadonlyArray<AuthGrantScope> = [
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  AuthDiagnosticsReadScope,
  AuthAccessReadScope,
];
const READ_ONLY = { app: APP_READ_SCOPES, gateway: ["read"] } as const;

/**
 * The one ceiling a network access level sets, per surface. MCP sessions enforce agent modes, so
 * they keep the level as their `mode` ceiling. App sessions and relayed gateway calls carry no
 * mode ceiling, so anything short of full access only reads. `revoked` grants nothing anywhere.
 */
export const NETWORK_ACCESS_CEILING = {
  revoked: { mode: null, app: [], gateway: [] },
  "read-only": { mode: "read-only", ...READ_ONLY },
  "approval-required": { mode: "approval-required", ...READ_ONLY },
  "auto-accept-edits": { mode: "auto-accept-edits", ...READ_ONLY },
  auto: { mode: "auto", ...READ_ONLY },
  "full-access": {
    mode: "full-access",
    app: AuthStandardClientScopes,
    gateway: GATEWAY_SCOPE_VALUES,
  },
} as const satisfies Record<
  TailnetDeviceAccess,
  {
    readonly mode: AuthMcpClientAccess | null;
    readonly app: ReadonlyArray<AuthGrantScope>;
    readonly gateway: ReadonlyArray<GatewayScope>;
  }
>;

/** Per-environment T3 Agents scopes a connected app grants to agents relayed through it. */
/** The most environments one app may relay; a larger registration is refused whole. */
export const MCP_GATEWAY_RELAY_GRANTS_MAX = 256;
export const McpGatewayRelayGrants = Schema.Record(
  Schema.String,
  Schema.Array(GatewayScope).check(Schema.isMaxLength(GATEWAY_SCOPE_VALUES.length)),
).check(Schema.isMaxProperties(MCP_GATEWAY_RELAY_GRANTS_MAX));
export type McpGatewayRelayGrants = typeof McpGatewayRelayGrants.Type;

export const McpGatewayConnectInput = Schema.Struct({ grants: McpGatewayRelayGrants });
export type McpGatewayConnectInput = typeof McpGatewayConnectInput.Type;

/** What a server would relay for the asking app under these grants, and why not the rest. */
export const McpGatewayRelayPreview = Schema.Struct({
  grants: Schema.Record(Schema.String, Schema.Array(GatewayScope)),
  refusals: Schema.Record(Schema.String, Schema.String),
  limit: Schema.optionalKey(Schema.String),
});
export type McpGatewayRelayPreview = typeof McpGatewayRelayPreview.Type;

/** A runtime port call an agent on this server needs a connected app to run on another environment. */
export const McpGatewayRelayEvent = Schema.Struct({
  type: Schema.Literal("invoke"),
  connectionId: Schema.String,
  invocationId: Schema.String,
  method: Schema.String,
  args: Schema.Array(Schema.Unknown),
  /**
   * The calling chat's modes. The app answering the call applies them against its own reads of
   * the target, since the relaying server's view of a remote thread is only what an app told it.
   */
  modeCeiling: Schema.optionalKey(
    Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
  ),
});
export type McpGatewayRelayEvent = typeof McpGatewayRelayEvent.Type;

export const McpGatewayRelayResponse = Schema.Struct({
  connectionId: Schema.String,
  invocationId: Schema.String,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.String),
  /** With `error`: the app did not run the call, because it cannot reach or was not granted it. */
  unreachable: Schema.optionalKey(Schema.Literal(true)),
  /** With `error`: the encoded `ThreadTaskError` it failed with. Ignored when it does not decode. */
  taskError: Schema.optionalKey(Schema.Unknown),
});
export type McpGatewayRelayResponse = typeof McpGatewayRelayResponse.Type;

/**
 * Relayed args and results are arbitrary runtime port values, but the relay encodes them as
 * JSON and rejects `undefined` anywhere inside them. One optional field left `undefined` would
 * otherwise fail the app's whole relay stream. Drops it the way `JSON.stringify` does; throws
 * only for values JSON cannot carry at all, such as cycles or bigints.
 */
export function toMcpGatewayRelayJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const RelayIso = Schema.optional(Schema.NullOr(Schema.String));
const RelaySettledAt = Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString));

/**
 * A thread as a relaying app's `getThread` reports it (`gatewayThreadProjection`). Fields an
 * older app or environment may not send are optional.
 */
export const McpGatewayRelayThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  modelSelection: Schema.Struct({ instanceId: ProviderInstanceId, model: Schema.String }),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  parentEnvironmentId: Schema.optional(Schema.NullOr(EnvironmentId)),
  profileSnapshot: Schema.optional(
    Schema.NullOr(Schema.Struct({ profileId: Schema.String, profileName: Schema.String })),
  ),
  settledAt: RelaySettledAt,
  settlementSource: Schema.optional(Schema.NullOr(Schema.Literals(["manual", "inactivity"]))),
  archivedAt: RelayIso,
  deletedAt: RelayIso,
  runs: Schema.Array(
    Schema.Struct({
      id: RunId,
      status: OrchestrationV2RunStatus,
      providerInstanceId: ProviderInstanceId,
      requestedAt: RelayIso,
      completedAt: RelayIso,
    }),
  ),
  messages: Schema.Array(
    Schema.Struct({
      id: MessageId,
      role: Schema.String,
      text: Schema.String,
      runId: Schema.optional(Schema.NullOr(RunId)),
      updatedAt: RelayIso,
    }),
  ),
  runtimeRequests: Schema.optional(Schema.Array(Schema.Unknown)),
  createdAt: RelayIso,
  updatedAt: RelayIso,
});
export type McpGatewayRelayThread = typeof McpGatewayRelayThread.Type;

/** The small per-thread summaries a relaying app's `listThreads` reports. */
export const McpGatewayRelayThreadList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: ThreadId,
      parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
      parentEnvironmentId: Schema.optional(Schema.NullOr(EnvironmentId)),
      settledAt: RelaySettledAt,
      activeRunId: Schema.optional(Schema.NullOr(RunId)),
    }),
  ),
});
export type McpGatewayRelayThreadList = typeof McpGatewayRelayThreadList.Type;

/** A call between a task's owner and worker environments. Inputs are encoded task contracts. */
export const McpGatewayRelayThreadTaskRequest = Schema.Struct({
  action: Schema.Literals([
    "remoteAssign",
    "remoteDeliver",
    "remoteOwnerAction",
    "projectSnapshot",
  ]),
  input: Schema.Unknown,
});
export type McpGatewayRelayThreadTaskRequest = typeof McpGatewayRelayThreadTaskRequest.Type;

/**
 * The runtime port calls a server makes through a connected app for itself, each with the
 * schema of its arguments and of its answer. The first argument is always the environment the
 * call acts on. Settle and task answers are read by their callers, so they stay unknown here.
 */
export const McpGatewayRelayCalls = {
  getThread: { args: Schema.Tuple([EnvironmentId, ThreadId]), result: McpGatewayRelayThread },
  listThreads: { args: Schema.Tuple([EnvironmentId]), result: McpGatewayRelayThreadList },
  settleThread: { args: Schema.Tuple([EnvironmentId, ThreadId]), result: Schema.Unknown },
  unsettleThread: { args: Schema.Tuple([EnvironmentId, ThreadId]), result: Schema.Unknown },
  threadTask: {
    args: Schema.Tuple([EnvironmentId, McpGatewayRelayThreadTaskRequest]),
    result: Schema.Unknown,
  },
} as const;
export type McpGatewayRelayMethod = keyof typeof McpGatewayRelayCalls;
export type McpGatewayRelayArgs<M extends McpGatewayRelayMethod> =
  (typeof McpGatewayRelayCalls)[M]["args"]["Type"];
export type McpGatewayRelayResult<M extends McpGatewayRelayMethod> =
  (typeof McpGatewayRelayCalls)[M]["result"]["Type"];
