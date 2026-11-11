import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/compat";
import type {
  AcpAdapterV2SubagentUpdate,
  AcpSubagentSessionEvent,
} from "@t3tools/provider-acp/server/adapter";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

/** Custom session-update metadata emitted by DeepSeek Harness for native child agents. */
export const DEEPSEEK_SUBAGENT_META = "deepseek.ai/subagent";

const decodeSubagentMeta = Schema.decodeUnknownOption(
  Schema.Struct({
    parentSessionId: Schema.String,
    runId: Schema.String,
    provider: Schema.optionalKey(Schema.String),
    local: Schema.optionalKey(Schema.Boolean),
    /** "delegated" publishes the prompt/title; all other values publish state. */
    phase: Schema.optionalKey(Schema.String),
    prompt: Schema.optionalKey(Schema.String),
    title: Schema.optionalKey(Schema.String),
  }),
);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * DeepSeek Harness exposes in-process children by sending standard ACP state updates under the
 * child's session id, tagged with `deepseek.ai/subagent` metadata. Map those frames into T3's
 * provider-native subagent stream.
 */
export function extractDeepseekSubagentSessionEvent(
  notification: AcpSchema.SessionNotification,
): AcpSubagentSessionEvent | undefined {
  const update = notification.update;
  const updateMeta = record("_meta" in update ? update._meta : undefined);
  const meta = Option.getOrUndefined(decodeSubagentMeta(updateMeta?.[DEEPSEEK_SUBAGENT_META]));
  if (meta === undefined) return undefined;

  if (meta.phase === "delegated") {
    return {
      type: "delegation",
      childSessionId: notification.sessionId,
      parentSessionId: meta.parentSessionId,
      delegationId: meta.runId,
      prompt: meta.prompt ?? meta.title ?? "",
    };
  }

  if (update.sessionUpdate !== "state_update") return undefined;
  if (update.state !== "idle") {
    return {
      type: "state",
      childSessionId: notification.sessionId,
      parentSessionId: meta.parentSessionId,
      status: "running",
      result: null,
    };
  }
  const status =
    update.stopReason === "error"
      ? "failed"
      : update.stopReason === "cancelled"
        ? "cancelled"
        : "completed";
  return {
    type: "state",
    childSessionId: notification.sessionId,
    parentSessionId: meta.parentSessionId,
    status,
    result: update.error?.message ?? null,
  };
}

/**
 * DeepSeek Harness is the only ACP agent here whose command is `dsh --profile acp`. Registry
 * installs use the agent id; local installs are identified by the launcher name.
 */
export function isDeepseekAcpAgent(registryAgentId: string, commandPath: string): boolean {
  if (/deepseek/i.test(registryAgentId)) return true;
  const binary = commandPath.split(/[\\/]/).pop() ?? "";
  return /^dsh(?:\.exe|\.cmd)?$/i.test(binary);
}

const decodeSubagentInput = Schema.decodeUnknownOption(
  Schema.Struct({
    prompt: Schema.String,
    description: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String),
  }),
);

function textFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const object = record(value);
  if (typeof object?.text === "string") return object.text;
  if (Array.isArray(object?.content)) {
    const text = object.content
      .map((item: unknown) => (record(item)?.text as string | undefined) ?? "")
      .join("");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

/** DSH reports the child session id in the structured result, or in its "agent <id>" text. */
export function deepseekSubagentIdFromOutput(output: unknown): string | undefined {
  const object = record(output);
  // Only the DSH subagent document keys identify the child. A generic `id` or `session_id`
  // can name a run, task, or unrelated record and would mislink the child session.
  for (const key of ["agent_id", "agentId"]) {
    const value = object?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  const text = textFromUnknown(output);
  if (text === undefined) return undefined;
  const match =
    text.match(/agent[ _-]?id\s*[:=]\s*([A-Za-z0-9_-]+)/i) ??
    text.match(/\(agent ([A-Za-z0-9_-]+)\)/i);
  return match?.[1];
}

/**
 * DSH's `subagent` tool starts a child in the background and returns immediately. The parent
 * tool call is the only place with the prompt, so publish a native subagent task from it. The
 * child session id is linked when the tool result exposes it (newer DSH) or when child state
 * frames arrive.
 */
export function extractDeepseekSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  if (tool.data.name !== "subagent" && tool.data.name !== "subagent_fork") return undefined;
  const input = Option.getOrUndefined(decodeSubagentInput(tool.data.rawInput));
  if (input === undefined) return undefined;
  const childSessionId = deepseekSubagentIdFromOutput(tool.data.rawOutput);
  const outputText = textFromUnknown(tool.data.rawOutput);
  return {
    nativeTaskId: tool.toolCallId,
    childSessionId: childSessionId ?? null,
    prompt: input.prompt,
    title: input.description ?? input.name ?? null,
    model: null,
    status: tool.status === "failed" ? "failed" : "running",
    result: tool.status === "failed" ? (outputText ?? null) : null,
  };
}
