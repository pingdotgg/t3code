import * as NodeCrypto from "node:crypto";

import {
  EventId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ThreadTokenUsageSnapshot,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  type ToolLifecycleItemType,
  type TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

/**
 * Pure OpenCode 2 SSE → ProviderRuntimeEvent translator.
 *
 * Input is one decoded v2 event frame (`{id, type, created, data}`). Output
 * is zero or more runtime events stamped with `provider: "opencode2"`. The
 * translator never throws: malformed frames and unknown types decode to `[]`.
 *
  // Dropped-with-reason (server-stream frames intentionally ignored):
  // - session.moved: cross-directory bookkeeping, no thread-visible change.
 // - session.inbox.* (delivered/enqueued/cancelled/delivery.changed):
 //  internal prompt-queue bookkeeping; the turn lifecycle (execution.*
 //  -> text/tool deltas) is the user-visible surface.
 // - session.agent.selected / session.model.selected: selection echo; the
 //  composer already owns the selection state it sent via switch calls.
 // - session.permissions: the effective ruleset snapshot; approvals still
 //  arrive as permission.asked/replied.
 // - session.viewed: idle-watermark acknowledgement, no visible change.
 // - session.message.content.updated: replay-only correction of completed
 //  content; live streaming already carries the text.
 // - session.usage.recorded: durable accounting twin of the ephemeral
 //  session.usage.updated (stays the accounting source server-side, never
 //  reaches clients); only session.usage.updated maps to
 //  thread.token-usage.updated.
 // - session.instructions.updated: system-prompt delta for the model, no
 //  user-visible message.
 // - session.step.started / session.step.streamed: provider-dispatch
 //  markers; the response boundary is session.step.ended
 //  (thread.token-usage.updated), failures are session.step.failed
 //  (runtime.error).
 // - session.shell.started / session.shell.ended: background-shell
 //  lifecycle for the shell service (command runs outside the turn's
 //  tool-call stream); not part of the assistant message.
 // - session.skill.activated: skill-invocation marker; the model-facing
 //  content arrives through the normal text/tool stream.
 // - session.synthetic: user-injected context note; T3 Code owns the user
 //  message it prompted with.
 // - session.compaction.started / session.compaction.delta: compaction
 //  progress; only the completed boundary (session.compaction.ended ->
 //  thread.state.changed=compacted) is user-visible. session.compacted is
 //  the deprecated predecessor; mapped to the same boundary when observed.
 //  session.compaction.failed surfaces as runtime.warning instead: a
 //  failed compaction needs attention, unlike progress noise.
 // - session.revert.staged / session.revert.cleared /
 //  session.revert.committed: checkpoint revert bookkeeping owned by the
 //  checkpoint store, not the activity timeline.
 // - agent.updated / command.updated / model.updated / provider.updated /
 //  skill.updated / reference.updated / project.updated / config.updated /
 //  credential.switched / credential.updated / filesystem.changed /
 //  plugin.updated / mcp.* / lsp.updated / tui.* / installation.* /
 //  vcs.branch.updated / websearch.updated / worktree.* / workspace.* /
 //  location.shutdown / server.connected / global.disposed: inventory,
 //  workspace, or tooling signals outside the thread/turn timeline. The
 //  warm-up inventory path (provider/model/agent/skill/command .list)
 //  already refreshes those surfaces.
 // - pty.created / pty.updated / pty.exited / pty.deleted /
 //  persistent-pty.added / persistent-pty.removed / shell.created /
 //  shell.exited / shell.deleted: terminal-instance lifecycle.
 //  Terminal ids are caller-scoped (a duplicate terminal id means a
 //  distinct terminal, never a second stream for the same item), so there
 //  is no per-id stream state to reconcile here.
 // - session.error: legacy v1 error frame; mapped defensively to
 //  runtime.error for old servers. The v2 failure surfaces are
 //  session.execution.failed (turn.completed/failed) and
 //  session.step.failed (runtime.error).
 //
 // Streaming assembly (text deltas, tool input) needs memory, so callers hold
 * one translator per subscribed session via `makeEventTranslator`.
 */

const PROVIDER = ProviderDriverKind.make("opencode2");

/** Routing context the caller owns; stamped onto every emitted event. */
export interface OpenCode2TranslatorContext {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
}

export interface OpenCode2TranslatorOptions {
  /** Override for deterministic tests; defaults to a UUID v4. */
  readonly newEventId?: () => EventId;
  /** Fallback clock when a frame carries no usable `created` timestamp. */
  readonly nowIso?: () => string;
}

export interface OpenCode2EventTranslator {
  readonly translate: (
    event: unknown,
    context: OpenCode2TranslatorContext,
  ) => ReadonlyArray<ProviderRuntimeEvent>;
}

interface TextPartState {
  readonly kind: "text" | "reasoning";
  readonly messageID: string;
  readonly ordinal: number;
  text: string;
  emitted: string;
}

interface ToolState {
  readonly messageID: string;
  readonly callID: string;
  readonly name: string;
  input: Record<string, unknown>;
  inputText: string;
  title?: string;
  status: "pending" | "running" | "completed" | "error";
  output?: string;
  error?: string;
}

interface FormFieldState {
  readonly key: string;
  readonly type?: string;
  readonly title?: string;
  readonly description?: string;
  readonly multiple?: boolean;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}

const textPartKey = (messageID: string, kind: string, ordinal: number): string =>
  `${messageID}:${kind}:${ordinal}`;

function trimText(value: unknown): string | undefined {
  if (!Predicate.isString(value)) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Predicate.isObject(value)) return undefined;
  return value as Record<string, unknown>;
}

function asCount(value: unknown): number | undefined {
  if (!Predicate.isNumber(value) || !Number.isFinite(value)) return undefined;
  // Token counts arrive from an external server: clamp to the safe-integer
  // range so downstream sums stay inside `NonNegativeInt` (Schema.Int rejects
  // anything past MAX_SAFE_INTEGER) instead of failing event validation.
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function textFromToolContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts: Array<string> = [];
  for (const entry of content) {
    const record = asRecord(entry);
    if (record !== undefined && record["type"] === "text" && Predicate.isString(record["text"])) {
      texts.push(record["text"]);
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** Reads `{message}` from both the v2 `{type, message}` and legacy `{name, data.message}` shapes. */
function errorMessageOf(value: unknown, fallback: string): string {
  const record = asRecord(value);
  const direct = record !== undefined ? trimText(record["message"]) : undefined;
  if (direct !== undefined) return direct;
  const data = record !== undefined ? asRecord(record["data"]) : undefined;
  return (data !== undefined ? trimText(data["message"]) : undefined) ?? fallback;
}

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized === "todowrite" || normalized === "todoread") return "dynamic_tool_call";
  if (normalized.includes("bash") || normalized.includes("command")) return "command_execution";
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) return "web_search";
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("image")) return "image_view";
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function mapPermissionToRequestType(
  action: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  const canonical = canonicalPermissionAction(action);
  switch (canonical) {
    case "read":
    case "list":
      return "file_read_approval";
    case "edit":
    case "write":
    case "patch":
      return "file_change_approval";
    case "question":
      // The interactive question tool resolves through form.created/replied
      // (user-input.requested/resolved), never through the approval queue.
      // Route it to unknown so it surfaces as a generic approval instead
      // of a miscategorized command approval.
      return "unknown";
    case "shell":
    case "bash":
    case "webfetch":
    case "websearch":
    case "subagent":
    case "task":
    case "glob":
    case "grep":
    case "lsp":
    case "skill":
    case "doom_loop":
    case "external_directory":
      return "command_execution_approval";
    default:
      return "unknown";
  }
}

/**
 * Canonical tool names differ between generations: v1 asks with `bash`/`task`
 * while the v2 plugins assert `shell`/`subagent`
 * (core/src/tool/plugin/{shell,subagent}.ts; tui canonicalToolName maps
 * bash->shell, task->subagent). Normalize before mapping so both shapes
 * land on the same approval type.
 */
function canonicalPermissionAction(action: string): string {
  const normalized = action.toLowerCase();
  if (normalized === "bash") return "shell";
  if (normalized === "task") return "subagent";
  if (normalized === "apply_patch") return "patch";
  return normalized;
}

function mapPermissionDecision(reply: unknown): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    default:
      return "decline";
  }
}

const PERMISSION_OPTIONS: ReadonlyArray<{
  readonly decision: "accept" | "acceptForSession" | "decline";
  readonly label: string;
  readonly warning?: string;
}> = [
  { decision: "accept", label: "Allow once" },
  {
    decision: "acceptForSession",
    label: "Allow for workspace",
    warning: "Applies to matching requests in other OpenCode sessions in this workspace.",
  },
  { decision: "decline", label: "Deny" },
];

/** Suffix of `next` not yet emitted after `previous`; undefined on rewrites. */
function pendingSuffix(previous: string, next: string): string | undefined {
  // A final `*.ended` text that rewrites (rather than extends) the emitted
  // prefix has no append-only representation — this protocol has no
  // replacement operation — so the caller must suppress the delta (the full
  // text still rides `item.completed`'s detail) instead of re-appending the
  // whole string and duplicating content downstream.
  return next.startsWith(previous) ? next.slice(previous.length) : undefined;
}

/**
 * Cap on retained completed text-part keys. Terminal parts evict their
 * assembly state (`text`/`emitted` strings) and keep only the key for
 * duplicate suppression; the cap bounds that metadata on long-lived
 * sessions. Evicting the oldest key means a very-late duplicate past the
 * cap could re-emit — an acceptable bounded-dedup tradeoff.
 */
const MAX_COMPLETED_TEXT_PART_KEYS = 512;

function threadUsageFromInfo(
  tokens: Record<string, unknown>,
): ThreadTokenUsageSnapshot | undefined {
  const input = asCount(tokens["input"]);
  const output = asCount(tokens["output"]);
  const reasoning = asCount(tokens["reasoning"]);
  const cache = asRecord(tokens["cache"]);
  const read = cache !== undefined ? asCount(cache["read"]) : undefined;
  const write = cache !== undefined ? asCount(cache["write"]) : undefined;
  if (
    input === undefined &&
    output === undefined &&
    reasoning === undefined &&
    read === undefined &&
    write === undefined
  ) {
    return undefined;
  }
  // Each count is already clamped to MAX_SAFE_INTEGER by `asCount`, but their
  // sum can still overflow it — clamp once more so `usedTokens` always
  // satisfies the `NonNegativeInt` contract no matter what the server sends.
  const usedTokens = Math.min(
    Number.MAX_SAFE_INTEGER,
    (input ?? 0) + (output ?? 0) + (reasoning ?? 0) + (read ?? 0) + (write ?? 0),
  );
  return {
    usedTokens,
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(read !== undefined ? { cachedInputTokens: read } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
  };
}

function toUserInputQuestion(fieldState: FormFieldState): UserInputQuestion {
  return {
    id: fieldState.key,
    header: fieldState.title ?? fieldState.key,
    question: fieldState.description ?? fieldState.title ?? fieldState.key,
    options: fieldState.options.map((option) => ({
      label: option.label,
      description: "",
      value: option.value,
    })),
    ...(fieldState.type === "multiselect" || fieldState.multiple === true
      ? { multiSelect: true }
      : {}),
  };
}

function stringifyAnswer(value: unknown): string {
  if (Predicate.isString(value)) return value;
  if (Predicate.isNumber(value) || Predicate.isBoolean(value)) return String(value);
  if (Array.isArray(value)) return value.map((entry) => stringifyAnswer(entry)).join(", ");
  return "";
}

export const makeEventTranslator = (
  options?: OpenCode2TranslatorOptions,
): OpenCode2EventTranslator => {
  const newEventId = options?.newEventId ?? (() => EventId.make(NodeCrypto.randomUUID()));
  // Synchronous wall-clock read for frames without a usable `created`
  // timestamp. Tests inject a fixed clock; production uses the live one.
  const nowIso = options?.nowIso ?? (() => DateTime.formatIso(Effect.runSync(DateTime.now)));
  const textParts = new Map<string, TextPartState>();
  // Completed text-part keys retained for bounded duplicate suppression.
  // Insertion-ordered: the oldest key evicts past the cap.
  const completedTextPartKeys = new Set<string>();
  const tools = new Map<string, ToolState>();
  const permissions = new Map<string, string>();
  const forms = new Map<string, ReadonlyArray<FormFieldState>>();
  const retrySignatures = new Map<string, string>();

  // Terminal text parts evict their `text`/`emitted` strings (unbounded
  // on long-lived sessions) and keep only the key for bounded duplicate
  // suppression (see MAX_COMPLETED_TEXT_PART_KEYS).
  const markTextPartCompleted = (key: string): void => {
    textParts.delete(key);
    completedTextPartKeys.delete(key);
    completedTextPartKeys.add(key);
    if (completedTextPartKeys.size > MAX_COMPLETED_TEXT_PART_KEYS) {
      const oldest = completedTextPartKeys.values().next().value;
      if (oldest !== undefined) {
        completedTextPartKeys.delete(oldest);
      }
    }
  };

  const createdAtOf = (created: unknown): string => {
    if (Predicate.isNumber(created) && Number.isFinite(created)) {
      return DateTime.make(created).pipe(Option.map(DateTime.formatIso), Option.getOrElse(nowIso));
    }
    return nowIso();
  };

  const baseOf = (
    context: OpenCode2TranslatorContext,
    createdAt: string,
    refs?: { readonly itemId?: string; readonly requestId?: string },
    raw?: unknown,
  ) => ({
    eventId: newEventId(),
    provider: PROVIDER,
    threadId: context.threadId,
    createdAt,
    ...(context.turnId !== undefined ? { turnId: context.turnId } : {}),
    ...(refs?.itemId !== undefined ? { itemId: RuntimeItemId.make(refs.itemId) } : {}),
    ...(refs?.requestId !== undefined ? { requestId: RuntimeRequestId.make(refs.requestId) } : {}),
    ...(raw !== undefined ? { raw: { source: "opencode.sdk.event" as const, payload: raw } } : {}),
  });

  const readFormFields = (value: unknown): ReadonlyArray<FormFieldState> | undefined => {
    if (!Array.isArray(value)) return undefined;
    const fields: Array<FormFieldState> = [];
    for (const entry of value) {
      const record = asRecord(entry);
      const key = record !== undefined ? trimText(record["key"]) : undefined;
      if (key === undefined) continue;
      // Form options are `{value, label?, description?}`; the question-tool
      // shape is `{label, description}` (no stable value), so fall back to
      // the label as the value to keep the option selectable.
      const recordOptions =
        record !== undefined && Array.isArray(record["options"]) ? record["options"] : [];
      const fieldOptions: Array<{ readonly value: string; readonly label: string }> = [];
      for (const option of recordOptions) {
        const optionRecord = asRecord(option);
        const optionValue =
          optionRecord !== undefined ? trimText(optionRecord["value"]) : undefined;
        const optionLabel =
          optionRecord !== undefined ? trimText(optionRecord["label"]) : undefined;
        const value = optionValue ?? optionLabel;
        if (value === undefined) continue;
        fieldOptions.push({ value, label: optionLabel ?? value });
      }
      const fieldType =
        record !== undefined && Predicate.isString(record["type"]) ? record["type"] : undefined;
      const fieldTitle = record !== undefined ? trimText(record["title"]) : undefined;
      const fieldDescription = record !== undefined ? trimText(record["description"]) : undefined;
      // The v2 question tool sends `multiple: true` on the prompt; form
      // fields use `type: "multiselect"`. Accept either.
      const multiple = record !== undefined && record["multiple"] === true ? true : undefined;
      fields.push({
        key,
        ...(fieldType !== undefined ? { type: fieldType } : {}),
        ...(fieldTitle !== undefined ? { title: fieldTitle } : {}),
        ...(fieldDescription !== undefined ? { description: fieldDescription } : {}),
        ...(multiple !== undefined ? { multiple } : {}),
        options: fieldOptions,
      });
    }
    return fields;
  };

  const translateTextual = (
    event: {
      readonly type: string;
      readonly created: unknown;
      readonly data: Record<string, unknown>;
    },
    context: OpenCode2TranslatorContext,
    raw: unknown,
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    const kind =
      event.type === "session.reasoning.started" ||
      event.type === "session.reasoning.delta" ||
      event.type === "session.reasoning.ended"
        ? "reasoning"
        : "text";
    const phase = event.type.endsWith(".started")
      ? "started"
      : event.type.endsWith(".delta")
        ? "delta"
        : "ended";
    const messageID = trimText(event.data["assistantMessageID"]);
    if (messageID === undefined) return [];
    const ordinal = asCount(event.data["ordinal"]) ?? 0;
    const key = textPartKey(messageID, kind, ordinal);
    const createdAt = createdAtOf(event.created);
    const itemType = kind === "reasoning" ? "reasoning" : "assistant_message";

    if (phase === "started") {
      // A started frame always begins a fresh logical part for the key
      // (retry/replay reuses keys): reset assembly state so the new text
      // does not inherit an old prefix (which would corrupt suffix math),
      // and clear any completed marker so the new stream can complete.
      completedTextPartKeys.delete(key);
      const part: TextPartState = { kind, messageID, ordinal, text: "", emitted: "" };
      textParts.set(key, part);
      return [
        {
          ...baseOf(context, createdAt, { itemId: key }, raw),
          type: "item.started",
          payload: {
            itemType,
            status: "inProgress",
            title: kind === "reasoning" ? "Reasoning" : "Assistant message",
          },
        },
      ];
    }

    const part = textParts.get(key);
    // Terminal state evicted to `completedTextPartKeys` (bounded dedup): a
    // frame for a completed key is a duplicate terminal, never a new part
    // (a new logical part always opens with a fresh started frame, which
    // clears the marker above). Without this guard an evicted key would
    // look like an orphan and re-emit.
    if (part === undefined && completedTextPartKeys.has(key)) return [];
    // Orphan delta/ended (no started frame — e.g. a late subscriber joining
    // mid-stream): seed the part so the end boundary still completes the
    // item instead of dropping the only copy of the text.
    if (part === undefined) {
      if (phase === "delta") {
        const orphanDelta = event.data["delta"];
        if (!Predicate.isString(orphanDelta) || orphanDelta.length === 0) return [];
        const seeded: TextPartState = {
          kind,
          messageID,
          ordinal,
          text: orphanDelta,
          emitted: "",
        };
        textParts.set(key, seeded);
        seeded.emitted = seeded.text;
        return [
          {
            ...baseOf(context, createdAt, { itemId: key }, raw),
            type: "content.delta",
            payload: {
              streamKind: kind === "reasoning" ? "reasoning_text" : "assistant_text",
              delta: orphanDelta,
            },
          },
        ];
      }
      const orphanText = event.data["text"];
      if (!Predicate.isString(orphanText)) return [];
      markTextPartCompleted(key);
      return [
        {
          ...baseOf(context, createdAt, { itemId: key }, raw),
          type: "item.completed",
          payload: {
            itemType,
            status: "completed",
            title: kind === "reasoning" ? "Reasoning" : "Assistant message",
            ...(orphanText.trim().length > 0 ? { detail: orphanText } : {}),
          },
        },
      ];
    }
    if (phase === "delta") {
      const delta = event.data["delta"];
      if (!Predicate.isString(delta) || delta.length === 0) return [];
      part.text += delta;
      part.emitted = part.text;
      return [
        {
          ...baseOf(context, createdAt, { itemId: key }, raw),
          type: "content.delta",
          payload: {
            streamKind: kind === "reasoning" ? "reasoning_text" : "assistant_text",
            delta,
          },
        },
      ];
    }

    const text = event.data["text"];
    if (!Predicate.isString(text)) return [];
    const out: Array<ProviderRuntimeEvent> = [];
    // Rewrite (final text does not extend the emitted prefix): suppress the
    // delta — there is no replacement operation, and appending the full text
    // would duplicate content downstream. The final text still rides
    // `item.completed`'s detail below.
    const pending = pendingSuffix(part.emitted, text);
    if (pending !== undefined && pending.length > 0) {
      part.emitted = text;
      out.push({
        ...baseOf(context, createdAt, { itemId: key }, raw),
        type: "content.delta",
        payload: {
          streamKind: kind === "reasoning" ? "reasoning_text" : "assistant_text",
          delta: pending,
        },
      });
    }
    out.push({
      ...baseOf(context, createdAt, { itemId: key }, raw),
      type: "item.completed",
      payload: {
        itemType,
        status: "completed",
        title: kind === "reasoning" ? "Reasoning" : "Assistant message",
        ...(text.trim().length > 0 ? { detail: text } : {}),
      },
    });
    markTextPartCompleted(key);
    return out;
  };

  const translateTool = (
    event: {
      readonly type: string;
      readonly created: unknown;
      readonly data: Record<string, unknown>;
    },
    context: OpenCode2TranslatorContext,
    raw: unknown,
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    const callID = trimText(event.data["id"]);
    if (callID === undefined) return [];
    const createdAt = createdAtOf(event.created);

    switch (event.type) {
      case "session.tool.input.started": {
        const name = trimText(event.data["name"]) ?? "tool";
        const tool: ToolState = {
          messageID: trimText(event.data["assistantMessageID"]) ?? "",
          callID,
          name,
          input: {},
          inputText: "",
          status: "pending",
        };
        tools.set(callID, tool);
        return [
          {
            ...baseOf(context, createdAt, { itemId: callID }, raw),
            type: "item.started",
            payload: {
              itemType: toToolLifecycleItemType(name),
              status: "inProgress",
              title: name,
              data: { tool: name },
            },
          },
        ];
      }

      case "session.tool.input.delta": {
        const tool = tools.get(callID);
        if (tool === undefined) return [];
        const delta = event.data["delta"];
        if (Predicate.isString(delta)) tool.inputText += delta;
        return [];
      }

      case "session.tool.input.ended":
      case "session.tool.called": {
        const tool = tools.get(callID);
        if (tool === undefined) return [];
        if (event.type === "session.tool.input.ended") {
          const text = event.data["text"];
          if (Predicate.isString(text)) {
            tool.inputText = text;
            try {
              const parsed: unknown = JSON.parse(text);
              const parsedRecord = asRecord(parsed);
              if (parsedRecord !== undefined) tool.input = parsedRecord;
            } catch {
              // Tool input may not be valid JSON yet; keep the last parsed value.
            }
          }
        } else {
          const input = asRecord(event.data["input"]);
          if (input !== undefined) {
            tool.input = input;
            tool.inputText = "";
          }
        }
        tool.status = "running";
        return [
          {
            ...baseOf(context, createdAt, { itemId: callID }, raw),
            type: "item.updated",
            payload: {
              itemType: toToolLifecycleItemType(tool.name),
              status: "inProgress",
              title: tool.title ?? tool.name,
              data: { tool: tool.name, input: tool.input },
            },
          },
        ];
      }

      case "session.tool.progress": {
        const tool = tools.get(callID);
        if (tool === undefined) return [];
        const metadata = asRecord(event.data["metadata"]);
        const title = metadata !== undefined ? trimText(metadata["title"]) : undefined;
        if (title !== undefined) tool.title = title;
        return [
          {
            ...baseOf(context, createdAt, { itemId: callID }, raw),
            type: "item.updated",
            payload: {
              itemType: toToolLifecycleItemType(tool.name),
              status: "inProgress",
              ...(tool.title !== undefined || tool.name.length > 0
                ? { title: tool.title ?? tool.name }
                : {}),
              data: { tool: tool.name, input: tool.input },
            },
          },
        ];
      }

      case "session.tool.success": {
        const tool = tools.get(callID);
        if (tool === undefined) return [];
        tool.status = "completed";
        const output = textFromToolContent(event.data["content"]);
        if (output !== undefined) tool.output = output;
        // Terminal call ids are caller-scoped: a duplicate id after the
        // terminal frame is a distinct call, never a second stream for the
        // same item. Evict so a stale entry cannot leak into the new call.
        tools.delete(callID);
        return [
          {
            ...baseOf(context, createdAt, { itemId: callID }, raw),
            type: "item.completed",
            payload: {
              itemType: toToolLifecycleItemType(tool.name),
              status: "completed",
              title: tool.title ?? tool.name,
              ...(tool.output !== undefined ? { detail: tool.output } : {}),
              data: {
                tool: tool.name,
                ...(tool.output !== undefined ? { output: tool.output } : {}),
              },
            },
          },
        ];
      }

      case "session.tool.failed": {
        const tool = tools.get(callID);
        if (tool === undefined) return [];
        tool.status = "error";
        const message = errorMessageOf(event.data["error"], "Tool failed.");
        tool.error = message;
        tools.delete(callID);
        return [
          {
            ...baseOf(context, createdAt, { itemId: callID }, raw),
            type: "item.completed",
            payload: {
              itemType: toToolLifecycleItemType(tool.name),
              status: "failed",
              title: tool.title ?? tool.name,
              detail: message,
              data: { tool: tool.name, error: message },
            },
          },
        ];
      }

      default:
        return [];
    }
  };

  const translate = (
    event: unknown,
    context: OpenCode2TranslatorContext,
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    const frame = asRecord(event);
    const type = frame !== undefined ? frame["type"] : undefined;
    if (!Predicate.isString(type) || frame === undefined) return [];
    const data = asRecord(frame["data"]);
    if (data === undefined) return [];
    const raw = event;
    const createdAt = createdAtOf(frame["created"]);
    const base = baseOf(context, createdAt, undefined, raw);
    const sessionID = trimText(data["sessionID"]);

    switch (type) {
      case "session.created":
      case "session.forked": {
        if (sessionID === undefined) return [];
        return [
          {
            ...baseOf(context, createdAt, undefined, raw),
            type: "thread.started",
            payload: { providerThreadId: sessionID },
          },
        ];
      }

      case "session.renamed": {
        const title = trimText(data["title"]);
        if (title === undefined) return [];
        return [{ ...base, type: "thread.metadata.updated", payload: { name: title } }];
      }

      case "session.metadata.updated": {
        const title = trimText(asRecord(data["metadata"])?.["title"]);
        if (title === undefined) return [];
        return [{ ...base, type: "thread.metadata.updated", payload: { name: title } }];
      }

      case "session.deleted": {
        return [{ ...base, type: "thread.state.changed", payload: { state: "closed" } }];
      }

      case "session.status": {
        const status = asRecord(data["status"]);
        const state = status !== undefined ? status["type"] : undefined;
        if (state === "busy") {
          return [{ ...base, type: "session.state.changed", payload: { state: "running" } }];
        }
        if (state === "idle") {
          return [{ ...base, type: "session.state.changed", payload: { state: "ready" } }];
        }
        if (state === "retry") {
          const attempt = asCount(status?.["attempt"]);
          const message = trimText(status?.["message"]) ?? "retrying";
          // Retry storms: a tight retry loop emits session.status/retry on
          // every tick. Warn once per (attempt, message) signature so the
          // activity timeline is not flooded with one warning per tick.
          const signature = `${attempt ?? "?"}:${message}`;
          if (retrySignatures.get(sessionID ?? "") === signature) {
            return [{ ...base, type: "session.state.changed", payload: { state: "running" } }];
          }
          retrySignatures.set(sessionID ?? "", signature);
          return [
            { ...base, type: "session.state.changed", payload: { state: "running" } },
            {
              ...baseOf(context, createdAt, undefined, raw),
              type: "runtime.warning",
              payload: {
                message:
                  attempt !== undefined
                    ? `OpenCode retry ${attempt}: ${message}`
                    : `OpenCode retry: ${message}`,
                detail: status,
              },
            },
          ];
        }
        return [];
      }

      case "session.idle": {
        return [{ ...base, type: "session.state.changed", payload: { state: "ready" } }];
      }

      case "session.execution.started": {
        return [{ ...base, type: "turn.started", payload: {} }];
      }

      case "session.execution.succeeded": {
        return [{ ...base, type: "turn.completed", payload: { state: "completed" } }];
      }

      case "session.execution.interrupted": {
        return [
          {
            ...base,
            type: "turn.aborted",
            payload: { reason: trimText(data["reason"]) ?? "interrupted" },
          },
        ];
      }

      case "session.execution.failed": {
        return [
          {
            ...base,
            type: "turn.completed",
            payload: {
              state: "failed",
              errorMessage: errorMessageOf(data["error"], "OpenCode session failed."),
            },
          },
        ];
      }

      case "session.retry.scheduled": {
        const attempt = asCount(data["attempt"]);
        const message = errorMessageOf(data["error"], "retrying");
        // Same dedupe as session.status/retry: warn once per attempt so a
        // tight retry loop does not flood the timeline.
        const signature = `scheduled:${attempt ?? "?"}:${message}`;
        if (retrySignatures.get(sessionID ?? "") === signature) return [];
        retrySignatures.set(sessionID ?? "", signature);
        return [
          {
            ...base,
            type: "runtime.warning",
            payload: {
              message:
                attempt !== undefined
                  ? `OpenCode retry ${attempt}: ${message}`
                  : `OpenCode retry: ${message}`,
              detail: data["error"],
            },
          },
        ];
      }

      case "session.text.started":
      case "session.text.delta":
      case "session.text.ended":
      case "session.reasoning.started":
      case "session.reasoning.delta":
      case "session.reasoning.ended": {
        return translateTextual({ type, created: frame["created"], data }, context, raw);
      }

      case "session.step.ended": {
        const tokens = asRecord(data["tokens"]);
        const usage = tokens !== undefined ? threadUsageFromInfo(tokens) : undefined;
        if (usage === undefined) return [];
        return [{ ...base, type: "thread.token-usage.updated", payload: { usage } }];
      }

      case "session.step.failed": {
        return [
          {
            ...base,
            type: "runtime.error",
            payload: {
              message: errorMessageOf(data["error"], "OpenCode session failed."),
              class: "provider_error",
              detail: data["error"],
            },
          },
        ];
      }

      case "session.tool.input.started":
      case "session.tool.input.delta":
      case "session.tool.input.ended":
      case "session.tool.called":
      case "session.tool.progress":
      case "session.tool.success":
      case "session.tool.failed": {
        return translateTool({ type, created: frame["created"], data }, context, raw);
      }

      case "session.compaction.ended":
      case "session.compacted": {
        return [{ ...base, type: "thread.state.changed", payload: { state: "compacted" } }];
      }

      case "session.compaction.failed": {
        return [
          {
            ...base,
            type: "runtime.warning",
            payload: {
              message: errorMessageOf(data["error"], "OpenCode compaction failed."),
              detail: data["error"],
            },
          },
        ];
      }

      case "session.usage.updated": {
        const tokens = asRecord(data["tokens"]);
        const usage = tokens !== undefined ? threadUsageFromInfo(tokens) : undefined;
        if (usage === undefined) return [];
        return [{ ...base, type: "thread.token-usage.updated", payload: { usage } }];
      }

      case "session.error": {
        const error = data["error"];
        if (error === undefined) return [];
        return [
          {
            ...base,
            type: "runtime.error",
            payload: {
              message: errorMessageOf(error, "OpenCode session failed."),
              class: "provider_error",
              detail: error,
            },
          },
        ];
      }

      case "permission.asked": {
        const id = trimText(data["id"]);
        const action = trimText(data["action"]);
        if (id === undefined || action === undefined) return [];
        permissions.set(id, action);
        const resources = Array.isArray(data["resources"]) ? data["resources"] : [];
        const patterns = resources.filter(
          (entry): entry is string => Predicate.isString(entry) && entry !== "*",
        );
        const detail =
          action === "bash" && patterns.length > 0
            ? patterns.join("\n")
            : [action.replaceAll("_", " "), ...patterns].join("\n");
        return [
          {
            ...baseOf(context, createdAt, { requestId: id }, raw),
            type: "request.opened",
            payload: {
              requestType: mapPermissionToRequestType(action),
              detail,
              ...(asRecord(data["metadata"]) !== undefined ? { args: data["metadata"] } : {}),
              options: [...PERMISSION_OPTIONS],
            },
          },
        ];
      }

      case "permission.replied": {
        const requestID = trimText(data["requestID"]);
        if (requestID === undefined) return [];
        const action = permissions.get(requestID);
        permissions.delete(requestID);
        return [
          {
            ...baseOf(context, createdAt, { requestId: requestID }, raw),
            type: "request.resolved",
            payload: {
              requestType: action !== undefined ? mapPermissionToRequestType(action) : "unknown",
              decision: mapPermissionDecision(data["reply"]),
            },
          },
        ];
      }

      case "form.created": {
        const form = asRecord(data["form"]);
        const id = form !== undefined ? trimText(form["id"]) : undefined;
        const fields = form !== undefined ? readFormFields(form["fields"]) : undefined;
        if (id === undefined || fields === undefined || fields.length === 0) return [];
        forms.set(id, fields);
        return [
          {
            ...baseOf(context, createdAt, { requestId: id }, raw),
            type: "user-input.requested",
            payload: { questions: fields.map(toUserInputQuestion) },
          },
        ];
      }

      case "form.replied": {
        const id = trimText(data["id"]);
        if (id === undefined) return [];
        const answer = asRecord(data["answer"]) ?? {};
        const fields = forms.get(id) ?? [];
        forms.delete(id);
        return [
          {
            ...baseOf(context, createdAt, { requestId: id }, raw),
            type: "user-input.resolved",
            payload: {
              answers: Object.fromEntries(
                fields.map((fieldState) => [
                  fieldState.key,
                  stringifyAnswer(answer[fieldState.key]),
                ]),
              ),
            },
          },
        ];
      }

      case "form.cancelled": {
        const id = trimText(data["id"]);
        if (id === undefined) return [];
        forms.delete(id);
        return [
          {
            ...baseOf(context, createdAt, { requestId: id }, raw),
            type: "user-input.resolved",
            payload: { answers: {} },
          },
        ];
      }

      default:
        return [];
    }
  };

  return { translate };
};
