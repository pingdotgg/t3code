// Adapter between the `zcode serve` daemon's row-based conversation projection and the event
// vocabulary this provider's session layer already speaks. The daemon streams row deltas,
// state patches and pending interactions; folding them belongs here so the transport stays
// thin and the mapping stays testable.
import * as Predicate from "effect/Predicate";

export type ZcodeRecord = Record<string, unknown>;

export interface ZcodeConversationEvent {
  readonly type: string;
  readonly payload: ZcodeRecord;
}

export interface ZcodeModelSelection {
  readonly providerId: string;
  readonly modelId: string;
}

export interface ZcodeConversationState {
  readonly rows: Map<number, ZcodeRecord>;
  revision: number;
  phase: string | undefined;
  /** The daemon rejects a stale `stop` without this id, so track it off the live control patch. */
  foregroundExecutionId: string | undefined;
  readonly pendingInteractions: Map<string, ZcodeRecord>;
  /** Interactions already surfaced as requests; resubscribes replay the snapshot. */
  readonly announcedInteractions: Set<string>;
  /** Streamed `output.text` per tool row; tool rows only carry the full text at the end. */
  readonly toolOutput: Map<number, string>;
  modelSelection: ZcodeModelSelection | undefined;
  thoughtLevels: ReadonlyArray<string>;
  thoughtLevel: string | undefined;
  /** Latest finished assistant text, used as the turn result summary. */
  lastAssistantText: string | undefined;
}

export const initialConversationState = (): ZcodeConversationState => ({
  rows: new Map(),
  revision: 0,
  phase: undefined,
  foregroundExecutionId: undefined,
  pendingInteractions: new Map(),
  announcedInteractions: new Set(),
  toolOutput: new Map(),
  modelSelection: undefined,
  thoughtLevels: [],
  thoughtLevel: undefined,
  lastAssistantText: undefined,
});

const field = (record: unknown, key: string): unknown =>
  Predicate.isObject(record) ? record[key] : undefined;

const text = (record: unknown, key: string): string | undefined => {
  const value = field(record, key);
  return Predicate.isString(value) ? value : undefined;
};

const number = (record: unknown, key: string): number | undefined => {
  const value = field(record, key);
  return Predicate.isNumber(value) && Number.isFinite(value) ? value : undefined;
};

const readConfig = (state: ZcodeConversationState, config: unknown): void => {
  const selection = field(config, "modelSelection");
  const providerId = text(selection, "providerId");
  const modelId = text(selection, "modelId");
  if (providerId !== undefined && modelId !== undefined) {
    state.modelSelection = { providerId, modelId };
  }
  const levels = field(config, "thoughtLevels");
  if (Array.isArray(levels)) {
    state.thoughtLevels = levels.filter(Predicate.isString);
  }
  const thought = text(config, "thought");
  if (thought !== undefined) state.thoughtLevel = thought;
};

const readControl = (state: ZcodeConversationState, control: unknown): void => {
  const phase = text(control, "phase");
  if (phase !== undefined) state.phase = phase;
  const activeWorks = field(control, "activeWorks");
  if (Array.isArray(activeWorks)) {
    const primary =
      activeWorks.find((work) => text(work, "kind") === "primaryTurn") ?? activeWorks[0];
    state.foregroundExecutionId = text(primary, "foregroundExecutionId");
  }
};

/** Deltas carry the suffix; full-row upserts carry the whole text, so diff against the last row. */
const appendedText = (previous: string, next: string): string => {
  if (previous.length === 0) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  let shared = 0;
  while (shared < previous.length && shared < next.length && previous[shared] === next[shared]) {
    shared += 1;
  }
  return next.slice(shared);
};

const streamTextEvent = (
  messageId: string,
  delta: string,
  kind: "text_delta" | "reasoning_delta",
  done: boolean,
): ZcodeConversationEvent => ({
  type: "model.streaming",
  payload: {
    assistantMessageId: messageId,
    delta,
    kind,
    ...(done ? { done: true } : {}),
  },
});

const rowEvents = (
  state: ZcodeConversationState,
  row: ZcodeRecord,
  previous: ZcodeRecord | undefined,
  append: string | undefined,
): ReadonlyArray<ZcodeConversationEvent> => {
  const kind = text(row, "kind");

  if (kind === "assistantText" || kind === "reasoning") {
    const messageId = text(row, "assistantResponseId") ?? text(row, "entityId");
    if (messageId === undefined) return [];
    const streamKind = kind === "assistantText" ? "text_delta" : "reasoning_delta";
    const nextText = text(row, "text") ?? "";
    const delta =
      append ??
      (previous === undefined ? nextText : appendedText(text(previous, "text") ?? "", nextText));
    const rowState = text(row, "state");
    const finishing =
      rowState !== undefined &&
      rowState !== "streaming" &&
      text(previous ?? {}, "state") !== rowState;
    const events: ZcodeConversationEvent[] = [];
    if (delta.length > 0 || finishing) {
      events.push(streamTextEvent(messageId, delta, streamKind, finishing));
    }
    if (kind === "assistantText" && nextText.length > 0 && rowState !== "streaming") {
      state.lastAssistantText = nextText;
    }
    return events;
  }

  if (kind === "toolCall") {
    const toolCallId = text(row, "toolCallId") ?? `row-${number(row, "rowId") ?? 0}`;
    const status = text(row, "status");
    const output = text(field(row, "output"), "text");
    const input = field(row, "input");
    const payload: ZcodeRecord = {
      toolCallId,
      toolName: text(row, "toolName"),
      input,
    };
    const previousStatus = text(previous ?? {}, "status");
    if (status === previousStatus) {
      const preview =
        text(field(row, "outputPreview"), "text") ?? text(field(row, "progress"), "previewLine");
      const previousPreview =
        text(field(previous ?? {}, "outputPreview"), "text") ??
        text(field(previous ?? {}, "progress"), "previewLine");
      if (preview !== undefined && preview.length > 0 && preview !== previousPreview) {
        return [
          {
            type: "tool.updated",
            payload: { ...payload, kind: "progress", outputPreview: { text: preview } },
          },
        ];
      }
      if (input !== undefined && field(previous ?? {}, "input") === undefined) {
        return [{ type: "tool.updated", payload: { ...payload, kind: "started" } }];
      }
      return [];
    }
    if (status === "error" || status === "cancelled") {
      const message = text(field(row, "error"), "message") ?? output ?? "Tool failed.";
      return [{ type: "tool.updated", payload: { ...payload, kind: "error", error: { message } } }];
    }
    if (status === "success") {
      return [
        {
          type: "tool.updated",
          payload: {
            ...payload,
            kind: "result",
            result: output === undefined ? {} : { output },
          },
        },
      ];
    }
    return [{ type: "tool.updated", payload: { ...payload, kind: "started" } }];
  }

  return [];
};

const INTERACTION_OPTION_KINDS: Record<string, { kind: string; decision: string }> = {
  allowOnce: { kind: "allow_once", decision: "allow" },
  allowAlways: { kind: "allow_always", decision: "allow" },
  deny: { kind: "deny", decision: "deny" },
  custom: { kind: "custom", decision: "allow" },
};

interface PermissionOption {
  readonly optionId: string;
  readonly kind: string;
  readonly name: string;
  readonly response: ZcodeRecord;
}

const permissionOptions = (payload: unknown): ReadonlyArray<PermissionOption> => {
  const raw = field(payload, "options");
  const options = Array.isArray(raw) ? [...raw] : [];
  const fullAccess = field(payload, "fullAccessOption");
  if (Predicate.isObject(fullAccess)) options.push(fullAccess);
  return options.flatMap((option): Array<PermissionOption> => {
    const optionId = text(option, "optionId");
    if (optionId === undefined) return [];
    const mapped = INTERACTION_OPTION_KINDS[text(option, "kind") ?? ""] ?? {
      kind: "custom",
      decision: "allow",
    };
    return [
      {
        optionId,
        kind: mapped.kind,
        name: text(option, "label") ?? optionId,
        // The session layer echoes this object back untouched; the transport turns it into
        // the daemon's `resolveInteraction` answer.
        response: { optionId, decision: mapped.decision },
      },
    ];
  });
};

interface UserInputView {
  readonly prompt: string;
  readonly inputType: "text" | "choice";
  readonly choices: ReadonlyArray<string>;
}

const userInputView = (payload: unknown): UserInputView => {
  const questions = field(payload, "questions");
  const question = Array.isArray(questions) ? questions[0] : undefined;
  const questionOptions = field(question, "options");
  const flatOptions = field(payload, "options");
  const labels = (candidates: unknown): ReadonlyArray<string> =>
    Array.isArray(candidates)
      ? candidates.flatMap((option): Array<string> => {
          const label = text(option, "label");
          return label === undefined ? [] : [label];
        })
      : [];
  const choices = labels(questionOptions ?? flatOptions);
  const freeText =
    field(payload, "freeText") === true || field(question, "multiSelect") !== undefined;
  return {
    prompt: text(question, "question") ?? text(payload, "prompt") ?? "The agent asked a question",
    inputType: freeText || choices.length === 0 ? "text" : "choice",
    choices,
  };
};

/**
 * Interaction events in this provider's vocabulary plus the server request that carries the
 * user's answer back to the daemon. Both key on the daemon interaction id.
 */
const interactionEvents = (
  state: ZcodeConversationState,
  interaction: ZcodeRecord,
): ReadonlyArray<ZcodeConversationEvent> => {
  const interactionId = text(interaction, "interactionId");
  if (interactionId === undefined || state.announcedInteractions.has(interactionId)) return [];
  const payload = field(interaction, "payload");
  const kind = text(interaction, "kind") ?? text(payload, "kind");
  const events: ZcodeConversationEvent[] = [];
  if (kind === "permission") {
    events.push({
      type: "permission.requested",
      payload: {
        requestId: interactionId,
        toolCallId: text(payload, "toolCallId"),
        toolName: text(payload, "toolName"),
        reason: text(payload, "summary"),
        options: permissionOptions(payload),
      },
    });
    events.push({
      type: "server.request",
      payload: {
        method: "interaction/requestPermission",
        params: {
          requestId: interactionId,
          toolCallId: text(payload, "toolCallId"),
          toolName: text(payload, "toolName"),
        },
      },
    });
  } else if (kind === "userInput") {
    const view = userInputView(payload);
    events.push({
      type: "userInput.requested",
      payload: {
        requestId: interactionId,
        prompt: view.prompt,
        inputType: view.inputType,
        choices: view.choices,
      },
    });
    events.push({
      type: "server.request",
      payload: {
        method: "interaction/requestUserInput",
        params: { requestId: interactionId },
      },
    });
  }
  state.announcedInteractions.add(interactionId);
  return events;
};

const interactionResolvedEvents = (
  interaction: ZcodeRecord,
): ReadonlyArray<ZcodeConversationEvent> => {
  const interactionId = text(interaction, "interactionId");
  if (interactionId === undefined) return [];
  const kind = text(interaction, "kind") ?? text(field(interaction, "payload"), "kind");
  return [
    {
      type: kind === "userInput" ? "userInput.resolved" : "permission.resolved",
      payload: { requestId: interactionId },
    },
  ];
};

const turnOutputTokens = (state: ZcodeConversationState): number | undefined => {
  let best: { rowId: number; tokens: number } | undefined;
  for (const [rowId, row] of state.rows) {
    if (text(row, "kind") !== "turnHeader") continue;
    const tokens = number(row, "outputTokens");
    if (tokens === undefined) continue;
    if (best === undefined || rowId > best.rowId) best = { rowId, tokens };
  }
  return best?.tokens;
};

const controlEvents = (
  state: ZcodeConversationState,
  control: unknown,
): ReadonlyArray<ZcodeConversationEvent> => {
  const phase = text(control, "phase");
  if (phase === undefined) return [];
  const previousPhase = state.phase;
  readControl(state, control);
  if (phase === previousPhase) return [];
  if (phase === "running" || phase === "prewarming") {
    state.lastAssistantText = undefined;
    return [{ type: "turn.started", payload: {} }];
  }
  if (previousPhase !== "running" && previousPhase !== "prewarming") return [];
  const tokenCount = turnOutputTokens(state);
  switch (phase) {
    case "completedSuccess":
      return [
        {
          type: "turn.completed",
          payload: {
            resultType: "success",
            ...(state.lastAssistantText === undefined ? {} : { response: state.lastAssistantText }),
            ...(tokenCount === undefined ? {} : { tokenCount }),
          },
        },
      ];
    case "completedInterrupted":
      return [{ type: "turn.completed", payload: { resultType: "cancelled" } }];
    case "error":
      return [
        {
          type: "turn.failed",
          payload: {
            error: {
              message: text(field(control, "lastError"), "message") ?? "ZCode turn failed.",
            },
          },
        },
      ];
    default:
      return [];
  }
};

/**
 * Folds one v4 conversation payload into `state` and returns the session events it produces.
 * Mutates `state`; callers keep exactly one state per native session.
 */
export function applyConversationPayload(
  state: ZcodeConversationState,
  payload: unknown,
  options: { readonly seedRows?: boolean } = {},
): ReadonlyArray<ZcodeConversationEvent> {
  const kind = text(payload, "kind");
  if (kind === "snapshot") {
    const snapshot = field(payload, "snapshot");
    const revision = number(snapshot, "revision");
    if (revision !== undefined) state.revision = revision;
    readConfig(state, field(snapshot, "config"));
    readControl(state, field(snapshot, "control"));
    const events: ZcodeConversationEvent[] = [];
    const rows = field(field(snapshot, "rows"), "window");
    if (Array.isArray(rows)) {
      for (const entry of rows) {
        const row = entry as ZcodeRecord;
        const rowId = number(row, "rowId");
        if (rowId === undefined) continue;
        state.rows.set(rowId, row);
        if (options.seedRows !== true) {
          events.push(...rowEvents(state, row, undefined, undefined));
        } else if (text(row, "kind") === "assistantText") {
          const rowText = text(row, "text");
          if (rowText !== undefined && rowText.length > 0) state.lastAssistantText = rowText;
        }
      }
    }
    const pending = field(snapshot, "pendingInteractions");
    if (Array.isArray(pending)) {
      for (const interaction of pending) {
        if (!Predicate.isObject(interaction)) continue;
        const id = text(interaction, "interactionId");
        if (id === undefined) continue;
        state.pendingInteractions.set(id, interaction);
        events.push(...interactionEvents(state, interaction));
      }
    }
    return events;
  }

  if (kind !== "deltas") return [];
  const deltas = field(payload, "deltas");
  if (!Array.isArray(deltas)) return [];
  const events: ZcodeConversationEvent[] = [];

  for (const entry of deltas) {
    const op = text(entry, "op");
    if (op === undefined) continue;
    if (op === "state.updated") {
      const patch = field(entry, "patch");
      const revision = number(patch, "revision");
      if (revision !== undefined) state.revision = revision;
      readConfig(state, field(patch, "config"));
      const control = field(patch, "control");
      if (control !== undefined) events.push(...controlEvents(state, control));
      const pending = field(patch, "pendingInteractions");
      if (Array.isArray(pending)) {
        const next = new Map<string, ZcodeRecord>();
        for (const interaction of pending) {
          if (!Predicate.isObject(interaction)) continue;
          const id = text(interaction, "interactionId");
          if (id === undefined) continue;
          next.set(id, interaction);
          const known = state.pendingInteractions.get(id);
          if (known === undefined) events.push(...interactionEvents(state, interaction));
        }
        for (const [id, previous] of state.pendingInteractions) {
          if (next.has(id)) continue;
          events.push(...interactionResolvedEvents(previous));
        }
        state.pendingInteractions.clear();
        for (const [id, interaction] of next) state.pendingInteractions.set(id, interaction);
      }
      continue;
    }
    if (op === "row.delta") {
      const rowId = number(entry, "rowId");
      const append = text(entry, "append");
      const path = text(entry, "path") ?? "text";
      if (rowId === undefined || append === undefined) continue;
      const row = state.rows.get(rowId);
      if (row === undefined) continue;
      const rowKind = text(row, "kind");
      if (rowKind === "toolCall") {
        if (path !== "output.text") continue;
        const accumulated = (state.toolOutput.get(rowId) ?? "") + append;
        state.toolOutput.set(rowId, accumulated);
        events.push({
          type: "tool.updated",
          payload: {
            toolCallId: text(row, "toolCallId") ?? `row-${rowId}`,
            toolName: text(row, "toolName"),
            input: field(row, "input"),
            kind: "progress",
            outputPreview: { text: accumulated },
          },
        });
        continue;
      }
      if (path !== "text") continue;
      const streamed = { ...row, text: (text(row, "text") ?? "") + append };
      state.rows.set(rowId, streamed);
      events.push(...rowEvents(state, streamed, row, append));
      continue;
    }
    if (op === "row.appended" || op === "row.upserted") {
      const row = field(entry, "row");
      if (!Predicate.isObject(row)) continue;
      const rowId = number(row, "rowId");
      if (rowId === undefined) continue;
      const previous = state.rows.get(rowId);
      state.rows.set(rowId, row);
      events.push(
        ...rowEvents(state, row, op === "row.appended" ? undefined : previous, undefined),
      );
      continue;
    }
    if (op === "row.removed") {
      const fromRowId = number(entry, "fromRowId");
      if (fromRowId === undefined) continue;
      const removed: number[] = [];
      for (const rowId of state.rows.keys()) {
        if (rowId >= fromRowId) removed.push(rowId);
      }
      for (const rowId of removed) state.rows.delete(rowId);
    }
  }

  return events;
}
