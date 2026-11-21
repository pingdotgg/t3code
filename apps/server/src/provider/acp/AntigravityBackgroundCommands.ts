// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite reads the native session database read-only.
import * as NodeSqlite from "node:sqlite";

import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { protoFields } from "./AntigravityChildWork.ts";
import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";
import { boundAntigravityToolText } from "./AntigravityProtocol.ts";

// CORTEX_STEP_TYPE_RUN_COMMAND in exa.cortex_pb.
const RUN_COMMAND_STEP_TYPE = 21;
// Active (non-terminal) CortexStepStatus values: PENDING, RUNNING, WAITING, QUEUED.
const ACTIVE_STEP_STATUSES = [1, 2, 9, 11] as const;
// Field numbers in exa.cortex_pb.CortexStep / CortexStepMetadata / ToolCall / RunCommandStep.
const STEP_METADATA = 5;
const METADATA_TOOL_CALL = 4;
const TOOL_CALL_ID = 1;
const TOOL_CALL_ARGS_JSON = 3;
const STEP_RUN_COMMAND = 28;
const RUN_COMMAND_CWD = 2;
const RUN_COMMAND_LINE = 23;
const RUN_COMMAND_PROPOSED_LINE = 25;

// Bound reads so a huge step payload or corrupted database never stalls settlement.
const MAX_ACTIVE_COMMANDS = 64;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const NATIVE_SESSION_ID = /^[\w-]{1,64}$/;
const CONVERSATION_SEGMENTS = ["antigravity-acp", "conversations"] as const;

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const fieldBytes = (bytes: Uint8Array | undefined, fieldNumber: number): Uint8Array | undefined => {
  if (bytes === undefined) return undefined;
  for (const [number, value] of protoFields(bytes)) {
    if (number === fieldNumber) return value;
  }
  return undefined;
};

const fieldText = (bytes: Uint8Array | undefined, fieldNumber: number): string | undefined => {
  const value = fieldBytes(bytes, fieldNumber);
  return value === undefined ? undefined : textDecoder.decode(value);
};

const CommandArgs = Schema.Struct({
  command: Schema.optional(Schema.String),
  CommandLine: Schema.optional(Schema.String),
  command_line: Schema.optional(Schema.String),
  commandLine: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  Cwd: Schema.optional(Schema.String),
  WorkingDirectory: Schema.optional(Schema.String),
  working_dir: Schema.optional(Schema.String),
  workingDir: Schema.optional(Schema.String),
  IsDaemon: Schema.optional(Schema.Boolean),
});

const decodeCommandArgsObject = Schema.decodeUnknownOption(CommandArgs);
const decodeCommandArgsJson = Schema.decodeUnknownOption(Schema.fromJsonString(CommandArgs));

const normalizeField = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? boundAntigravityToolText(trimmed) : undefined;
};

interface ActiveNativeCommand {
  readonly callId: string | undefined;
  readonly command: string | undefined;
  readonly cwd: string | undefined;
  readonly isDaemon: boolean;
}

function decodeActiveCommand(
  metadata: Uint8Array | null,
  payload: Uint8Array | null,
): ActiveNativeCommand | undefined {
  try {
    const metaBytes =
      metadata ?? (payload === null ? undefined : fieldBytes(payload, STEP_METADATA));
    const toolCall = fieldBytes(metaBytes, METADATA_TOOL_CALL);
    const callId = fieldText(toolCall, TOOL_CALL_ID);
    const argsJson = fieldText(toolCall, TOOL_CALL_ARGS_JSON);
    const args =
      argsJson === undefined ? undefined : Option.getOrUndefined(decodeCommandArgsJson(argsJson));
    const runCommand = payload === null ? undefined : fieldBytes(payload, STEP_RUN_COMMAND);
    const rawCommand =
      args?.CommandLine ??
      args?.command_line ??
      args?.commandLine ??
      args?.command ??
      fieldText(runCommand, RUN_COMMAND_LINE) ??
      fieldText(runCommand, RUN_COMMAND_PROPOSED_LINE);
    const rawCwd =
      args?.Cwd ??
      args?.WorkingDirectory ??
      args?.working_dir ??
      args?.workingDir ??
      args?.cwd ??
      fieldText(runCommand, RUN_COMMAND_CWD);
    return {
      callId,
      command: normalizeField(rawCommand),
      cwd: normalizeField(rawCwd),
      isDaemon: args?.IsDaemon === true,
    };
  } catch {
    return undefined;
  }
}

function toolCommandIdentity(tool: AcpToolCallState): {
  readonly command: string | undefined;
  readonly cwd: string | undefined;
} {
  const rawArgs = Option.getOrUndefined(decodeCommandArgsObject(tool.data.rawInput));
  const rawCommand =
    tool.command ??
    (typeof tool.data.command === "string" ? tool.data.command : undefined) ??
    rawArgs?.CommandLine ??
    rawArgs?.command_line ??
    rawArgs?.commandLine ??
    rawArgs?.command;
  const rawCwd =
    (typeof tool.data.cwd === "string" ? tool.data.cwd : undefined) ??
    rawArgs?.Cwd ??
    rawArgs?.WorkingDirectory ??
    rawArgs?.working_dir ??
    rawArgs?.workingDir ??
    rawArgs?.cwd;
  return {
    command: normalizeField(rawCommand),
    cwd: normalizeField(rawCwd),
  };
}

class AntigravityBackgroundCommandsReadError extends Schema.TaggedError<AntigravityBackgroundCommandsReadError>()(
  "AntigravityBackgroundCommandsReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read running commands from the Antigravity session database.";
  }
}

/**
 * Canceled background `run_command` steps (`manage_task(kill)`) get no terminal `tool_call_update`.
 * Returns `tools` still active in `conversations/<sessionId>.db`, or `undefined` if unproven.
 */
export const readAntigravityRunningCommands = Effect.fn("readAntigravityRunningCommands")(
  function* (input: {
    readonly profileDirectory: string;
    readonly sessionId: string;
    readonly tools: ReadonlyArray<AcpToolCallState>;
  }) {
    const nonExecuteIds: Array<string> = [];
    const executeTools: Array<AcpToolCallState> = [];
    for (const tool of input.tools) {
      if (tool.kind === "execute") executeTools.push(tool);
      else nonExecuteIds.push(tool.toolCallId);
    }
    if (executeTools.length === 0) return nonExecuteIds as ReadonlyArray<string>;
    if (!NATIVE_SESSION_ID.test(input.sessionId)) return undefined;
    const read = async (): Promise<ReadonlyArray<string> | undefined> => {
      const profileRoot = await antigravityProfileRoot(input.profileDirectory);
      if (profileRoot === undefined) return undefined;
      const databaseFile = await antigravityManagedPath(
        profileRoot,
        [...CONVERSATION_SEGMENTS, `${input.sessionId}.db`],
        "file",
      );
      if (databaseFile === undefined) return undefined;
      const database = new NodeSqlite.DatabaseSync(databaseFile.path, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout = 100");
        const hasSteps =
          database
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
            .get() !== undefined;
        if (!hasSteps) return undefined;
        const rows = database
          .prepare(
            `SELECT
               CASE WHEN length(metadata) <= ? THEN metadata ELSE NULL END AS metadata,
               length(metadata) AS metadataBytes,
               CASE WHEN length(step_payload) <= ? THEN step_payload ELSE NULL END AS payload
             FROM steps
             WHERE step_type = ? AND status IN (${ACTIVE_STEP_STATUSES.join(", ")})
             ORDER BY idx DESC
             LIMIT ?`,
          )
          .all(
            MAX_METADATA_BYTES,
            MAX_PAYLOAD_BYTES,
            RUN_COMMAND_STEP_TYPE,
            MAX_ACTIVE_COMMANDS + 1,
          );
        if (rows.length > MAX_ACTIVE_COMMANDS) return undefined;
        if (rows.length === 0) {
          const hasAnyCommand =
            database
              .prepare("SELECT 1 FROM steps WHERE step_type = ? LIMIT 1")
              .get(RUN_COMMAND_STEP_TYPE) !== undefined;
          return hasAnyCommand ? nonExecuteIds : undefined;
        }
        const active: Array<ActiveNativeCommand> = [];
        for (const row of rows) {
          if (typeof row.metadataBytes === "number" && row.metadataBytes > MAX_METADATA_BYTES) {
            return undefined;
          }
          const metadata = row.metadata instanceof Uint8Array ? row.metadata : null;
          const payload = row.payload instanceof Uint8Array ? row.payload : null;
          const decoded = decodeActiveCommand(metadata, payload);
          if (decoded === undefined) return undefined;
          if (decoded.isDaemon) continue;
          if (decoded.callId === undefined && decoded.command === undefined) return undefined;
          active.push(decoded);
        }
        if (active.length === 0) return nonExecuteIds;
        const remainingActive = [...active];
        const stillRunning: Array<string> = [...nonExecuteIds];
        const unmatchedTools: Array<{
          readonly tool: AcpToolCallState;
          readonly identity: ReturnType<typeof toolCommandIdentity>;
        }> = [];
        // Pass 1: exact callId matches are unambiguous even when command text is absent.
        for (const tool of executeTools) {
          const exactIndex = remainingActive.findIndex(
            (entry) => entry.callId !== undefined && entry.callId === tool.toolCallId,
          );
          if (exactIndex !== -1) {
            remainingActive.splice(exactIndex, 1);
            stillRunning.push(tool.toolCallId);
          } else {
            unmatchedTools.push({ tool, identity: toolCommandIdentity(tool) });
          }
        }
        if (unmatchedTools.length === 0 || remainingActive.length === 0) {
          return stillRunning;
        }
        // Any remaining active row or open tool without command text cannot be attributed safely.
        if (
          remainingActive.some((entry) => entry.command === undefined) ||
          unmatchedTools.some((entry) => entry.identity.command === undefined)
        ) {
          return undefined;
        }
        const matchesCommand = (
          entry: ActiveNativeCommand,
          identity: ReturnType<typeof toolCommandIdentity>,
        ) =>
          entry.command === identity.command &&
          (identity.cwd === undefined || entry.cwd === undefined || entry.cwd === identity.cwd);
        for (const candidate of unmatchedTools) {
          const matchingActive = remainingActive.filter((entry) =>
            matchesCommand(entry, candidate.identity),
          );
          if (matchingActive.length === 0) continue;
          const competingTools = unmatchedTools.filter((other) =>
            matchingActive.some((entry) => matchesCommand(entry, other.identity)),
          );
          // Do not guess which duplicate command is live when fewer active rows exist than tools.
          if (competingTools.length > matchingActive.length) {
            return undefined;
          }
          stillRunning.push(candidate.tool.toolCallId);
        }
        return stillRunning;
      } finally {
        database.close();
      }
    };
    return yield* Effect.tryPromise({
      try: read,
      catch: (cause) => new AntigravityBackgroundCommandsReadError({ cause }),
    }).pipe(Effect.orElseSucceed(() => undefined));
  },
);
