import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DaemonId = TrimmedNonEmptyString.pipe(Schema.brand("DaemonId"));
export type DaemonId = typeof DaemonId.Type;

const DAEMON_TERMINAL_ID = "daemon";

/** The terminal session a daemon runs in; the thread key never names a real thread. */
export const daemonTerminalTarget = (id: DaemonId) => ({
  threadId: `daemon:${id}`,
  terminalId: DAEMON_TERMINAL_ID,
});

export const DaemonDefinition = Schema.Struct({
  id: DaemonId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  // Passed to the PTY through an environment variable, which terminal env caps at 8 KiB.
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(8_192)),
  cwd: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type DaemonDefinition = typeof DaemonDefinition.Type;

export const DaemonState = Schema.Literals(["running", "stopped", "restarting"]);
export type DaemonState = typeof DaemonState.Type;

export const DaemonStatus = Schema.Struct({
  state: DaemonState,
  pid: Schema.NullOr(Schema.Int),
  startedAt: Schema.NullOr(IsoDateTime),
  nextAttemptAt: Schema.NullOr(IsoDateTime),
  lastExitCode: Schema.NullOr(Schema.Int),
  lastExitAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
});
export type DaemonStatus = typeof DaemonStatus.Type;

export const Daemon = Schema.Struct({
  ...DaemonDefinition.fields,
  status: DaemonStatus,
});
export type Daemon = typeof Daemon.Type;

export const DaemonListInput = Schema.Struct({});
export const DaemonListResult = Schema.Struct({ daemons: Schema.Array(Daemon) });
export type DaemonListResult = typeof DaemonListResult.Type;

export const DaemonUpsertInput = Schema.Struct({
  ...DaemonDefinition.fields,
  id: Schema.optional(DaemonId),
});
export type DaemonUpsertInput = typeof DaemonUpsertInput.Type;

export const DaemonIdInput = Schema.Struct({ id: DaemonId });
export type DaemonIdInput = typeof DaemonIdInput.Type;

export const DaemonMutationResult = Schema.Struct({ daemon: Daemon });
export type DaemonMutationResult = typeof DaemonMutationResult.Type;

export class DaemonError extends Schema.TaggedError<DaemonError>()("DaemonError", {
  message: Schema.String,
  daemonId: Schema.optional(DaemonId),
  cause: Schema.optional(Schema.Defect()),
}) {}

export const DAEMON_WS_METHODS = {
  subscribe: "daemons.subscribe",
  upsert: "daemons.upsert",
  delete: "daemons.delete",
  restart: "daemons.restart",
} as const;

const DaemonRpcError = Schema.Union([DaemonError, EnvironmentAuthorizationError]);

export const DAEMON_RPCS = [
  Rpc.make(DAEMON_WS_METHODS.subscribe, {
    payload: DaemonListInput,
    success: DaemonListResult,
    error: DaemonRpcError,
    stream: true,
  }),
  Rpc.make(DAEMON_WS_METHODS.upsert, {
    payload: DaemonUpsertInput,
    success: DaemonMutationResult,
    error: DaemonRpcError,
  }),
  Rpc.make(DAEMON_WS_METHODS.delete, {
    payload: DaemonIdInput,
    success: Schema.Struct({}),
    error: DaemonRpcError,
  }),
  Rpc.make(DAEMON_WS_METHODS.restart, {
    payload: DaemonIdInput,
    success: DaemonMutationResult,
    error: DaemonRpcError,
  }),
] as const;

// A daemon runs arbitrary shell commands, as a shell-mode scheduled task does.
export const DAEMON_CLIENT_GUARDED_RPC_SCOPES = {
  [DAEMON_WS_METHODS.upsert]: AuthOrchestrationOperateScope,
  [DAEMON_WS_METHODS.delete]: AuthOrchestrationOperateScope,
  [DAEMON_WS_METHODS.restart]: AuthOrchestrationOperateScope,
} as const;

export const DAEMON_RPC_REQUIRED_SCOPES = {
  ...DAEMON_CLIENT_GUARDED_RPC_SCOPES,
  [DAEMON_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
} as const;
