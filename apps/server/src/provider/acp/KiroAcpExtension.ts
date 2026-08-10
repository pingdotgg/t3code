/**
 * KiroAcpExtension — Kiro-shaped payloads that are not part of ACP proper.
 *
 * Everything here is derived from what kiro-cli 2.16.2 actually sends and is
 * decoded leniently: Kiro flags its extensions as experimental, so an
 * unrecognised or reshaped payload must degrade to "no information" rather
 * than failing a turn.
 *
 * @module provider/acp/KiroAcpExtension
 */
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import type { AcpPlanUpdate } from "./AcpRuntimeModel.ts";

/** Tool name Kiro reports for its task-list tool. */
const KIRO_TODO_TOOL_NAME = "todo_list";

/**
 * `_meta.kiro` rides along on Kiro's tool calls and names the tool behind the
 * generic ACP `tool_call` envelope.
 */
const KiroToolMeta = Schema.Struct({
  kiro: Schema.optional(
    Schema.Struct({
      toolName: Schema.optional(Schema.String),
    }),
  ),
});

/** Arguments Kiro passes to `todo_list`. */
const KiroTodoRawInput = Schema.Struct({
  command: Schema.optional(Schema.String),
  task_list_description: Schema.optional(Schema.String),
  tasks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        task_description: Schema.optional(Schema.String),
      }),
    ),
  ),
});

/**
 * Result Kiro reports once a `todo_list` command has run. This is the
 * authoritative list — it carries every task with its completion flag, so the
 * plan never has to be reconstructed from a sequence of commands.
 */
const KiroTodoRawOutput = Schema.Struct({
  items: Schema.optional(
    Schema.Array(
      Schema.Struct({
        Json: Schema.optional(
          Schema.Struct({
            description: Schema.optional(Schema.String),
            tasks: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  id: Schema.optional(Schema.String),
                  task_description: Schema.optional(Schema.String),
                  completed: Schema.optional(Schema.Boolean),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  ),
});

/** The `session/update` payload as Kiro sends it for a tool call. */
const KiroToolCallNotification = Schema.Struct({
  update: Schema.optional(
    Schema.Struct({
      _meta: Schema.optional(KiroToolMeta),
      rawInput: Schema.optional(KiroTodoRawInput),
      rawOutput: Schema.optional(KiroTodoRawOutput),
    }),
  ),
});

const decodeToolCallNotificationExit = Schema.decodeUnknownExit(KiroToolCallNotification);

function decodeToolCallNotification(
  rawPayload: unknown,
): typeof KiroToolCallNotification.Type | undefined {
  const result = decodeToolCallNotificationExit(rawPayload);
  return Exit.isSuccess(result) ? result.value : undefined;
}

/**
 * Whether a tool-call notification is Kiro's task-list tool.
 *
 * Detection is by `_meta.kiro.toolName`, because the ACP envelope only reports
 * a generic `other` tool kind for it.
 */
export function isKiroTodoToolCall(rawPayload: unknown): boolean {
  return (
    decodeToolCallNotification(rawPayload)?.update?._meta?.kiro?.toolName === KIRO_TODO_TOOL_NAME
  );
}

/**
 * Plan derived from a Kiro `todo_list` tool call, or `undefined` when the
 * payload carries no task list.
 *
 * Prefers `rawOutput`, which reports each task's completion state after the
 * command ran. Falls back to `rawInput.tasks` so the list still appears while
 * the tool call is only announced, in which case every step reads as pending.
 * Kiro tracks tasks as done-or-not, so `inProgress` is never invented.
 */
export function extractKiroTodoPlan(rawPayload: unknown): AcpPlanUpdate | undefined {
  const update = decodeToolCallNotification(rawPayload)?.update;
  if (!update) {
    return undefined;
  }

  const reportedList = update.rawOutput?.items?.find(
    (item) => (item.Json?.tasks?.length ?? 0) > 0,
  )?.Json;
  if (reportedList?.tasks && reportedList.tasks.length > 0) {
    const plan = reportedList.tasks.flatMap((task) => {
      const step = task.task_description?.trim();
      if (!step) return [];
      return [
        { step, status: task.completed === true ? ("completed" as const) : ("pending" as const) },
      ];
    });
    if (plan.length > 0) {
      const explanation = reportedList.description?.trim();
      return { ...(explanation ? { explanation } : {}), plan };
    }
  }

  const requestedTasks = update.rawInput?.tasks;
  if (requestedTasks && requestedTasks.length > 0) {
    const plan = requestedTasks.flatMap((task) => {
      const step = task.task_description?.trim();
      return step ? [{ step, status: "pending" as const }] : [];
    });
    if (plan.length > 0) {
      const explanation = update.rawInput?.task_list_description?.trim();
      return { ...(explanation ? { explanation } : {}), plan };
    }
  }

  return undefined;
}

// ── Extension notifications ───────────────────────────────────────────

/** Prefix Kiro uses for every extension method, per the ACP extensibility rules. */
export const KIRO_EXTENSION_METHOD_PREFIX = "_kiro.dev/";

const KiroAvailableCommandsParams = Schema.Struct({
  commands: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        description: Schema.optional(Schema.String),
      }),
    ),
  ),
});

const KiroMcpServerParams = Schema.Struct({
  serverName: Schema.optional(Schema.String),
});

/**
 * OAuth prompt for an MCP server.
 *
 * Unlike the other payloads here this one has not been observed in the wild —
 * every MCP server in reach was already authorised — so several plausible URL
 * field names are accepted and the raw payload is always logged alongside.
 */
const KiroMcpOauthParams = Schema.Struct({
  serverName: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  authorizationUrl: Schema.optional(Schema.String),
  oauthUrl: Schema.optional(Schema.String),
});

const KiroMetadataParams = Schema.Struct({
  contextUsagePercentage: Schema.optional(Schema.Number),
  turnDurationMs: Schema.optional(Schema.Number),
});

const KiroStatusParams = Schema.Struct({
  status: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

const decodeAvailableCommandsExit = Schema.decodeUnknownExit(KiroAvailableCommandsParams);
const decodeMcpServerExit = Schema.decodeUnknownExit(KiroMcpServerParams);
const decodeMcpOauthExit = Schema.decodeUnknownExit(KiroMcpOauthParams);
const decodeMetadataExit = Schema.decodeUnknownExit(KiroMetadataParams);
const decodeStatusExit = Schema.decodeUnknownExit(KiroStatusParams);

function decoded<A>(exit: Exit.Exit<A, unknown>): A | undefined {
  return Exit.isSuccess(exit) ? exit.value : undefined;
}

/**
 * A Kiro extension notification, classified into the handful of shapes worth
 * acting on.
 *
 * Everything falls back to `Unrecognised`, which callers log and drop: Kiro
 * marks these extensions experimental, so an unknown method or a reshaped
 * payload must never disturb a turn.
 */
export type KiroExtensionNotification =
  | {
      readonly _tag: "AvailableCommands";
      readonly commandNames: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "McpServerInitialized";
      readonly serverName: string | undefined;
    }
  | {
      /** An MCP server needs the user to authorise it before its tools work. */
      readonly _tag: "McpAuthorizationRequired";
      readonly serverName: string | undefined;
      readonly url: string | undefined;
    }
  | {
      /**
       * Kiro's own usage report. Deliberately not mapped onto T3 Code's token
       * usage: Kiro reports a context percentage and credit spend, not token
       * counts, and converting one into the other would invent numbers.
       */
      readonly _tag: "UsageReport";
      readonly contextUsagePercentage: number | undefined;
      readonly turnDurationMs: number | undefined;
    }
  | {
      readonly _tag: "CompactionStatus";
      readonly detail: string | undefined;
    }
  | {
      readonly _tag: "ClearStatus";
      readonly detail: string | undefined;
    }
  | {
      /** Streaming tool arguments; the real `tool_call` follows on session/update. */
      readonly _tag: "ToolCallChunk";
    }
  | {
      readonly _tag: "SubagentListUpdate";
    }
  | {
      readonly _tag: "Unrecognised";
      readonly method: string;
    };

export function classifyKiroExtensionNotification(
  method: string,
  params: unknown,
): KiroExtensionNotification {
  switch (method) {
    case "_kiro.dev/commands/available": {
      const commands = decoded(decodeAvailableCommandsExit(params))?.commands ?? [];
      return {
        _tag: "AvailableCommands",
        commandNames: commands.flatMap((command) => {
          const name = command.name?.trim();
          return name ? [name] : [];
        }),
      };
    }
    case "_kiro.dev/mcp/server_initialized":
      return {
        _tag: "McpServerInitialized",
        serverName: decoded(decodeMcpServerExit(params))?.serverName?.trim() || undefined,
      };
    case "_kiro.dev/mcp/oauth_request": {
      const payload = decoded(decodeMcpOauthExit(params));
      return {
        _tag: "McpAuthorizationRequired",
        serverName: payload?.serverName?.trim() || undefined,
        url:
          payload?.url?.trim() ||
          payload?.authorizationUrl?.trim() ||
          payload?.oauthUrl?.trim() ||
          undefined,
      };
    }
    case "_kiro.dev/metadata": {
      const payload = decoded(decodeMetadataExit(params));
      return {
        _tag: "UsageReport",
        contextUsagePercentage: payload?.contextUsagePercentage,
        turnDurationMs: payload?.turnDurationMs,
      };
    }
    case "_kiro.dev/compaction/status":
      return {
        _tag: "CompactionStatus",
        detail: decoded(decodeStatusExit(params))?.status?.trim() || undefined,
      };
    case "_kiro.dev/clear/status":
      return {
        _tag: "ClearStatus",
        detail: decoded(decodeStatusExit(params))?.status?.trim() || undefined,
      };
    case "_kiro.dev/session/update":
      return { _tag: "ToolCallChunk" };
    case "_kiro.dev/subagent/list_update":
      return { _tag: "SubagentListUpdate" };
    default:
      return { _tag: "Unrecognised", method };
  }
}
