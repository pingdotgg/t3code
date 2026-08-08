/**
 * Aether event mapper — the single transform from Aether's two transports
 * (workspace WS agent events + durable conversation rows) into t3
 * `ProviderRuntimeEvent`s, per docs/aether-driver-plumbing-spec.md §2.1.
 *
 * Design rules (spec §2.1 envelope row, build item 6):
 *   - Event IDs are DETERMINISTIC, derived from durable row identity — never
 *     a fresh UUID. t3 persists activities keyed by eventId and snapshots the
 *     resume cursor only at startSession/sendTurn/stopAll, so a crash replays
 *     already-ingested rows; deterministic IDs make the replay collide
 *     (idempotent) instead of duplicating:
 *       message items → `aether:<taskId>:item:<canonicalMessageId>`
 *       tool lifecycle → `aether:<taskId>:tool:<toolCallId>:<wireStatus>`
 *       durable rows without an entity → `aether:<taskId>:seq:<sequence>`
 *       turn settles → `aether:<taskId>:turn:<wireTurnId>:<suffix>`
 *       pending inputs → `aether:<taskId>:input:<pendingInputId>[:suffix]`
 *   - Durable wins: a completion seen live is not re-emitted from its REST
 *     twin and vice versa. Canonical message ids strip the durable
 *     `assistant:` prefix and always CARRY the `thinking:` prefix (the live
 *     stream already thinking-prefixes those ids — task-stream-emitter.ts).
 *   - `turnId`s are the deterministic `aether-turn-<wireTurnId>` family. The
 *     wire turn id IS the user message id that opened the turn
 *     (workspace-service handler.ts `const turnId = msg.messageId`), which is
 *     also `activeProcessingTurn.messageId` — so live and durable settles
 *     converge on the same t3 TurnId, matching `snapshotTurnsFromMessages`.
 *   - Status projection (spec resolved note 2): post-settle
 *     `awaiting_input(kind=message)` is the READY idle state — NO state
 *     emission; `waiting` is emitted ONLY for an actually-pending question or
 *     plan. Anything else keeps the just-settled turn flipped back to
 *     "Working" forever in t3's projection.
 *
 * The mapper is a plain synchronous state machine (no Effect, no I/O): the
 * caller feeds parsed wire events / decoded REST payloads and emits the
 * returned runtime events in order.
 *
 * @module provider/Layers/aether/eventMapper
 */
import {
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type RuntimeItemStatus,
  type RuntimePlanStepStatus,
  type ThreadId,
  type UserInputQuestion,
} from "@t3tools/contracts";

import type { AetherConversationDelta, AetherTask, AetherTimelineTool } from "./restSchemas.ts";
import { toolLifecycleItemTypeFromAether } from "./vendored/canonicalItemType.ts";
import { parseFileChanges } from "./vendored/toolDisplay.ts";
import type { AetherAgentEvent, AetherWsToolPayload } from "./wireEvents.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface AetherEventMapperOptions {
  readonly provider: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly taskId: string;
  /** Replay point: durable rows at or below this sequence are already applied. */
  readonly initialSequence: number;
}

/**
 * One selectable option of an open ask_user question, keyed for the answer
 * wire: Aether's respond verb addresses options by their RAW index in the
 * tool input's options array (packages/conversation question-drafts.ts —
 * "question identity is array position"), so the mapper records the raw
 * index alongside the label the t3 UI echoes back.
 */
export interface AetherAnswerableOption {
  readonly label: string;
  readonly rawIndex: number;
}

export interface AetherAnswerableQuestion {
  /** The id emitted on the t3 `user-input.requested` question (unique per input). */
  readonly id: string;
  /** The question's raw index in the wire input — the `answers` record key. */
  readonly rawIndex: number;
  readonly multiSelect: boolean;
  readonly options: ReadonlyArray<AetherAnswerableOption>;
}

/**
 * The single pending interaction the remote task is parked on. Aether's
 * domain holds at most ONE pending input per task (the
 * `tasks.pending_question_payload` slot — a new callback overwrites it
 * wholesale), so the mapper mirrors that as a single open slot.
 */
export interface AetherOpenUserInput {
  /** `pendingInputId` (WS) ≡ `tool_id` (REST) — the id the respond verb answers. */
  readonly pendingId: string;
  readonly toolName: "ask_user" | "propose_plan";
  /** The wire turn that asked, when known (stamps the resolution event). */
  readonly wireTurnId: string | undefined;
  /** Empty for propose_plan. */
  readonly questions: ReadonlyArray<AetherAnswerableQuestion>;
}

export interface AetherEventMapper {
  /** Map one parsed live WS agent event. `slash_commands.updated` maps to []. */
  readonly mapWsEvent: (
    event: AetherAgentEvent,
    nowIso: string,
  ) => ReadonlyArray<ProviderRuntimeEvent>;
  /**
   * Reconcile a durable conversation delta: replay rows above the cursor
   * through the same mapping paths (durable-wins dedupe), then project the
   * task status — the ONLY recovery for a turn settle missed while detached
   * (turn.* events are live-only, never persisted). Drive this on every WS
   * (re)connect and from the T6 turn engine's backstop poll.
   */
  readonly reconcileDelta: (
    delta: AetherConversationDelta,
    nowIso: string,
  ) => ReadonlyArray<ProviderRuntimeEvent>;
  /**
   * Project a bare task read (status flips without new rows). Exposed as the
   * poll hook the T6 turn engine drives; reconcileDelta calls it internally.
   */
  readonly reconcileTask: (task: AetherTask, nowIso: string) => ReadonlyArray<ProviderRuntimeEvent>;
  /** The highest durable sequence applied so far (in-memory cursor). */
  readonly latestSequence: () => number;
  /** The wire turn id currently tracked as in flight, if any. */
  readonly activeWireTurnId: () => string | undefined;
  /**
   * Does this RAW live wire turn id belong to a turn the DURABLE side already
   * grounded here — i.e. is the frame carrying it this driver's own output
   * rather than evidence of a turn injected from the Aether app (build item
   * 13)? The live transport stamps a fresh per-dispatch id on every frame, so
   * the caller cannot answer this by comparing against durable ids itself.
   *
   * PURE, unlike `resolveLiveWireTurnId`: it binds no alias, because the
   * caller asks BEFORE the frame is mapped and a genuinely remote id must
   * stay free to bind to the durable turn the caller's reconcile is about to
   * ground.
   */
  readonly isOwnLiveTurnId: (rawTurnId: string) => boolean;
  /**
   * Register a driver-initiated turn (sendTurn minted it from the 202 /
   * harvested user row) as the active wire turn, so a settle observed ONLY
   * through the REST backstop (durable rows carry no turn ids) still finds
   * the turn to settle. Returns the displaced predecessor's settle events,
   * exactly like an observed turn transition.
   */
  readonly noteTurnStarted: (
    wireTurnId: string,
    nowIso: string,
  ) => ReadonlyArray<ProviderRuntimeEvent>;
  /**
   * Flag a wire turn as user-interrupted (T6 interruptTurn): its single
   * terminal settle — whichever transport observes it — emits
   * `turn.completed state=interrupted`, and a `turn.failed` twin arriving
   * after the stop skips its error card (a stop is not a provider failure).
   */
  readonly markInterrupted: (wireTurnId: string) => void;
  /**
   * The pending input the remote task is currently parked on, if any —
   * the answer-side twin of `user-input.requested`/`turn.proposed.completed`
   * (build item 9: respondToUserInput / plan accept read it to build the
   * aether-exact tool_response).
   */
  readonly openUserInput: () => AetherOpenUserInput | undefined;
  /**
   * The driver answered the open input itself (respond 202 landed): emit its
   * `user-input.resolved` (ask_user only — plan cards have no resolution
   * event) carrying the submitted answers, and close the slot so the durable
   * reconcile does not re-resolve it. A stale/mismatched pendingId maps to []
   * — the slot was already resolved out of band.
   */
  readonly noteInputResolved: (
    pendingId: string,
    answers: Record<string, unknown>,
    nowIso: string,
  ) => ReadonlyArray<ProviderRuntimeEvent>;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/**
 * Canonical message-item id shared by both transports. Durable assistant
 * text rows may arrive `assistant:`-prefixed while the live stream uses the
 * bare id — strip it. Thinking ids keep their `thinking:` prefix: the live
 * stream ALSO prefixes them, so the prefixed form is already the shared one.
 */
function canonicalMessageItemId(messageId: string): string {
  return messageId.startsWith("assistant:") ? messageId.slice("assistant:".length) : messageId;
}

function canonicalThinkingItemId(messageId: string): string {
  return messageId.startsWith("thinking:") ? messageId : `thinking:${messageId}`;
}

/** Aether tool status → t3 item status (spec §2.1 tool-status row). */
function runtimeItemStatusFromAether(status: string): RuntimeItemStatus {
  switch (status) {
    case "output-error":
      return "failed";
    case "output-denied":
      return "declined";
    case "output-available":
    case "approval-responded":
      return "completed";
    default:
      return "inProgress";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** A trimmed non-empty string or undefined — t3 detail/title fields are TrimmedNonEmptyString. */
function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

const MCP_TOOL_NAME_RE = /^mcp__([^_].*?)__(.+)$/;

interface TerminalBlockView {
  readonly command: string;
  readonly stdout: string | undefined;
  readonly stderr: string | undefined;
  readonly exitCode: number | undefined;
}

/** First `terminal` display block, read defensively (blocks are untrusted). */
function readTerminalBlock(
  blocks: ReadonlyArray<unknown> | undefined,
): TerminalBlockView | undefined {
  for (const block of blocks ?? []) {
    if (!isRecord(block) || block.type !== "terminal") {
      continue;
    }
    const command = readString(block, "command");
    if (command === undefined) {
      continue;
    }
    const exitCode = block.exitCode;
    return {
      command,
      stdout: readString(block, "stdout"),
      stderr: readString(block, "stderr"),
      exitCode: typeof exitCode === "number" ? exitCode : undefined,
    };
  }
  return undefined;
}

interface TodoView {
  readonly step: string;
  readonly status: RuntimePlanStepStatus;
}

/** All `todo_list` items across display blocks (inline turn-plan chip source). */
function readTodoItems(blocks: ReadonlyArray<unknown> | undefined): ReadonlyArray<TodoView> {
  const todos: Array<TodoView> = [];
  for (const block of blocks ?? []) {
    if (!isRecord(block) || block.type !== "todo_list" || !Array.isArray(block.items)) {
      continue;
    }
    for (const item of block.items) {
      if (!isRecord(item)) {
        continue;
      }
      const step = trimmedOrUndefined(readString(item, "text"));
      if (step === undefined) {
        continue;
      }
      const status = item.status;
      todos.push({
        step,
        status:
          status === "completed"
            ? "completed"
            : status === "in_progress"
              ? "inProgress"
              : "pending",
      });
    }
  }
  return todos;
}

interface ParsedQuestions {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly issues: ReadonlyArray<string>;
  /**
   * Aligned 1:1 with `questions`: the raw wire indices the aether respond
   * verb keys `answers`/`customAnswers` by. Malformed questions/options are
   * SKIPPED from `questions`, which shifts positions — the raw indices here
   * are the only correct answer keys after such a skip.
   */
  readonly answerable: ReadonlyArray<AetherAnswerableQuestion>;
}

/**
 * One loose parser over the ask_user input for BOTH transports (WS
 * `payload.input`, REST `awaiting_input.input` — spec §2.4 question-card
 * row). Missing option descriptions are synthesized (= label) so t3's
 * parseUserInputQuestions never drops a question; malformed entries are
 * reported as issues, never silently dropped.
 */
export function parseAetherQuestions(input: Record<string, unknown>): ParsedQuestions {
  const issues: Array<string> = [];
  const rawQuestions = Array.isArray(input.questions) ? input.questions : undefined;
  if (rawQuestions === undefined) {
    return { questions: [], issues: ["ask_user input carries no questions array"], answerable: [] };
  }
  const questions: Array<UserInputQuestion> = [];
  const answerable: Array<AetherAnswerableQuestion> = [];
  // t3 keys answers by question id, so ids must be unique per input even
  // though the wire's `id` is optional and the synthesized fallback (the
  // question text) can repeat — a collision gets the raw index appended.
  const usedIds = new Set<string>();
  rawQuestions.forEach((raw, index) => {
    if (!isRecord(raw)) {
      issues.push(`question ${index} is not an object`);
      return;
    }
    const question = trimmedOrUndefined(readString(raw, "question"));
    if (question === undefined) {
      issues.push(`question ${index} has no question text`);
      return;
    }
    const options: Array<{ label: string; description: string }> = [];
    const answerableOptions: Array<AetherAnswerableOption> = [];
    if (Array.isArray(raw.options)) {
      raw.options.forEach((rawOption, optionIndex) => {
        if (!isRecord(rawOption)) {
          issues.push(`question ${index} option ${optionIndex} is not an object`);
          return;
        }
        const label = trimmedOrUndefined(readString(rawOption, "label"));
        if (label === undefined) {
          issues.push(`question ${index} option ${optionIndex} has no label`);
          return;
        }
        // Synthesize a missing/blank description from the label.
        options.push({
          label,
          description: trimmedOrUndefined(readString(rawOption, "description")) ?? label,
        });
        answerableOptions.push({ label, rawIndex: optionIndex });
      });
    }
    let id = trimmedOrUndefined(readString(raw, "id")) ?? question;
    if (usedIds.has(id)) {
      id = `${id}#${index + 1}`;
    }
    usedIds.add(id);
    const multiSelect = raw.multiSelect === true;
    questions.push({
      id,
      header: trimmedOrUndefined(readString(raw, "header")) ?? `Question ${index + 1}`,
      question,
      options,
      multiSelect,
    });
    answerable.push({ id, rawIndex: index, multiSelect, options: answerableOptions });
  });
  return { questions, issues, answerable };
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

export function makeAetherEventMapper(options: AetherEventMapperOptions): AetherEventMapper {
  const { provider, instanceId, threadId, taskId } = options;

  let lastSequence = options.initialSequence;
  /** Canonical message ids whose item.completed already went out (either transport). */
  const completedItems = new Set<string>();
  /** Wire turn ids that already received their single terminal settle. */
  const settledTurns = new Set<string>();
  /** Pending-input ids (WS pendingInputId ≡ REST tool_id) already surfaced. */
  const requestedInputs = new Set<string>();
  /** Tool call ids already seen (item.started vs item.updated). */
  const seenTools = new Set<string>();
  /**
   * `(toolCallId, wire status)` pairs already emitted. Live re-emits of a
   * pair stay last-write-wins (the wire upserts full state), but a DURABLE
   * row replay of a pair observed live is suppressed: the REST projection is
   * strictly poorer (no turnId, no display blocks), and its identical
   * deterministic eventId would overwrite the richer live activity wholesale.
   */
  const emittedToolStatuses = new Set<string>();
  /** Per-message content.delta counters (deterministic within a connection). */
  const deltaCounters = new Map<string, number>();
  /** One-shot flags for deduped task-level projections. */
  let taskErrorEmitted = false;
  const warnedOnce = new Set<string>();
  /** The wire turn id currently in flight, for settles observed via REST. */
  let activeWireTurnId: string | undefined;
  /**
   * The last durable turn that was in flight, RETAINED past its settle. A
   * settle clears `activeWireTurnId`, and the REST backstop can settle a turn
   * before the live stream's first frame for that dispatch ever bound its
   * random id (`reconcileTask` observing awaiting_input/processing on a poll
   * beat) — the settle-before-bind race. A late live `turn.completed` /
   * `turn.failed` then carries an id nothing grounded; resolving it to the last
   * durable turn keeps it inside `durableTurns`, so the durable-authoritative
   * gate suppresses its live settle instead of letting it fall through to the
   * cold path and open a phantom `aether-turn-<random>`. Its content tail
   * attributes to that same settled turn.
   */
  let lastDurableWireTurnId: string | undefined;
  /**
   * Turn ids the DURABLE side established — the ONLY source of turn identity
   * (an opening user row, `activeProcessingTurn`, or the driver's own
   * `noteTurnStarted`). The live WS transport stamps every frame with a FRESH
   * per-dispatch `turnId` (a `crypto.randomUUID` minted per prompt in aether
   * agent-handlers.ts), which is NEVER the durable user-row id the rest of the
   * driver keys turns by. A single user turn therefore arrives under two id
   * namespaces.
   *
   * Settlement is DURABLE-AUTHORITATIVE: once a turn is grounded here, the
   * live random-id `turn.completed`/`turn.failed`/`turn.awaiting_input` frames
   * do NOT settle it (mapWsEvent returns tracking only); the durable reconcile
   * observing the task-status flip owns the single settle. This makes an
   * ambiguous live id unable to settle any turn (right, wrong, or phantom).
   * Live frames still ATTRIBUTE content to the grounded turn (ownership is
   * safe). A live id is authoritative for turn identity — and still settles —
   * only in the cold mapper-only path where nothing durable grounds it (unit
   * tests / a degenerate resume).
   */
  const durableTurns = new Set<string>();
  /**
   * Live per-dispatch wire turn id → the durable turn it belongs to. Bound the
   * first time a live frame is seen while a durable turn is in flight, so the
   * whole live stream attributes CONTENT to the ONE durable turn (and
   * `isOwnLiveTurnId` can classify the frame as this driver's own output).
   * Settlement no longer rides this alias — it is durable-authoritative.
   */
  const liveTurnAlias = new Map<string, string>();
  /**
   * The single pending interaction, mirroring Aether's one-slot domain
   * (`tasks.pending_question_payload`). Set when the input surfaces, cleared
   * by the driver's own answer (`noteInputResolved`) or by an out-of-band
   * resolution observed on either transport (build item 14).
   */
  let openInput: AetherOpenUserInput | undefined;
  /** Wire turns the user interrupted — their settle state is `interrupted`. */
  const interruptedTurns = new Set<string>();
  /**
   * The session state ingestion currently believes, mirrored so the status
   * projection (spec §2.1 working-indicator row) emits only on transitions.
   * Updated by projectSessionState, by turn settles (ingestion flips a
   * settled session to ready/error itself) and by the `waiting` emission.
   */
  let lastProjectedState: "starting" | "running" | "waiting" | "ready" | "error" | undefined;
  /** Transition counter — keeps re-entered states' eventIds distinct while staying deterministic for a replayed observation sequence. */
  let stateEmissions = 0;
  /** Monotonic createdAt clock (spec: never decreasing). */
  let clockMs = Number.NEGATIVE_INFINITY;
  let clockIso = "";

  const stamp = (preferred: string | undefined, nowIso: string): string => {
    for (const candidate of [preferred, nowIso]) {
      if (candidate === undefined) {
        continue;
      }
      const ms = Date.parse(candidate);
      if (!Number.isFinite(ms)) {
        continue;
      }
      if (ms <= clockMs) {
        return clockIso;
      }
      clockMs = ms;
      clockIso = candidate;
      return candidate;
    }
    return clockIso;
  };

  const turnIdFor = (wireTurnId: string): TurnId => TurnId.make(`aether-turn-${wireTurnId}`);

  const base = (input: {
    readonly eventId: string;
    readonly createdAt: string;
    readonly wireTurnId?: string | undefined;
    readonly itemId?: string | undefined;
    readonly requestId?: string | undefined;
  }) => ({
    eventId: EventId.make(input.eventId),
    provider,
    providerInstanceId: instanceId,
    threadId,
    createdAt: input.createdAt,
    ...(input.wireTurnId !== undefined ? { turnId: turnIdFor(input.wireTurnId) } : {}),
    ...(input.itemId !== undefined ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    ...(input.requestId !== undefined ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
  });

  /**
   * Track the wire turn an event belongs to. A DIFFERENT unsettled turn
   * becoming active proves the previously tracked turn ended (Aether runs
   * one turn at a time), so its missed live-only settle is emitted here —
   * otherwise an awaiting_input→processing transition between observations
   * (fast remote respond) would silently overwrite the predecessor and its
   * `turn.completed` would never surface, violating the exactly-one-terminal-
   * settle-per-turn contract (spec §2.1 turn-settle row).
   */
  const trackTurn = (
    wireTurnId: string | undefined,
    createdAt: string,
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    if (wireTurnId === undefined || settledTurns.has(wireTurnId)) {
      return [];
    }
    const events: Array<ProviderRuntimeEvent> = [];
    if (activeWireTurnId !== undefined && activeWireTurnId !== wireTurnId) {
      events.push(...settleTurn({ wireTurnId: activeWireTurnId, state: "completed", createdAt }));
    }
    // A turn OTHER than the one that asked becoming active proves the
    // pending input was answered out of band (an answer is the only thing
    // that resumes a parked task) — clear the panel (build item 14).
    if (openInput !== undefined && openInput.wireTurnId !== wireTurnId) {
      events.push(...resolveOpenInput({}, createdAt));
    }
    activeWireTurnId = wireTurnId;
    if (durableTurns.has(wireTurnId)) {
      lastDurableWireTurnId = wireTurnId;
    }
    return events;
  };

  /** Record a turn id the DURABLE side established (see `durableTurns`). */
  const noteDurableTurn = (wireTurnId: string | undefined): void => {
    if (wireTurnId !== undefined) {
      durableTurns.add(wireTurnId);
    }
  };

  /**
   * Attribute a live frame's per-dispatch wire turn id to the durable turn it
   * belongs to (see `durableTurns` / `liveTurnAlias`). A live id never opens or
   * transitions a turn: while a durable turn is active, EVERY live id resolves
   * to it (bound once so the whole live stream attributes to the one durable
   * turn); after it settled, an id nothing ever bound resolves to that same
   * last durable turn (see `lastDurableWireTurnId`); with no durable turn EVER
   * grounded — the cold mapper-only path — the live id stands in as its own
   * turn unchanged.
   */
  function resolveLiveWireTurnId(rawTurnId: string): string;
  function resolveLiveWireTurnId(rawTurnId: string | undefined): string | undefined;
  function resolveLiveWireTurnId(rawTurnId: string | undefined): string | undefined {
    if (rawTurnId === undefined) {
      return undefined;
    }
    const aliased = liveTurnAlias.get(rawTurnId);
    if (aliased !== undefined) {
      return aliased;
    }
    if (activeWireTurnId !== undefined && durableTurns.has(activeWireTurnId)) {
      liveTurnAlias.set(rawTurnId, activeWireTurnId);
      return activeWireTurnId;
    }
    // Settled-before-bind: no durable turn is in flight, so this frame is the
    // tail of the one that just settled. Deliberately NOT bound — the binding
    // above keeps a turn's whole live stream together, while this is a
    // best-effort attribution for a turn already over; leaving the id unbound
    // lets the very next frame re-resolve onto a NEW durable turn as soon as
    // one is grounded (the eager reconcile of a remote injection). Resolving to
    // the last durable turn keeps the id inside `durableTurns` so the
    // durable-authoritative gate suppresses its settle (no phantom).
    if (lastDurableWireTurnId !== undefined) {
      return lastDurableWireTurnId;
    }
    return rawTurnId;
  }

  /** See `AetherEventMapper.isOwnLiveTurnId` — pure, binds nothing. */
  const isOwnLiveTurnId = (rawTurnId: string): boolean =>
    liveTurnAlias.has(rawTurnId) ||
    durableTurns.has(rawTurnId) ||
    // A durable turn in flight owns every live frame that arrives while it
    // runs — that is exactly the binding rule above. `lastDurableWireTurnId`
    // deliberately does NOT count: between turns a live frame is the first
    // evidence of a turn injected from the Aether app, and claiming it as our
    // own would suppress the remote-originated warning (build item 13).
    (activeWireTurnId !== undefined && durableTurns.has(activeWireTurnId));

  /**
   * The status projection (spec §2.1 working-indicator row): queued→starting,
   * processing→running, errored→error, emitted only when the projected state
   * actually changes. `waiting` and READY are NOT projected here — waiting is
   * bound to an actually-pending input (pendingInput) and READY is the
   * absence of an emission after a settle (spec resolved note 2).
   */
  const projectSessionState = (
    state: "starting" | "running" | "error",
    reason: string | undefined,
    createdAt: string,
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    if (lastProjectedState === state) {
      return [];
    }
    lastProjectedState = state;
    stateEmissions++;
    const trimmedReason = trimmedOrUndefined(reason);
    return [
      {
        ...base({ eventId: `aether:${taskId}:state:${stateEmissions}:${state}`, createdAt }),
        type: "session.state.changed",
        payload: { state, ...(trimmedReason !== undefined ? { reason: trimmedReason } : {}) },
      },
    ];
  };

  const warningOnce = (
    key: string,
    message: string,
    detail: unknown,
    createdAt: string,
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    if (warnedOnce.has(key)) {
      return [];
    }
    warnedOnce.add(key);
    return [
      {
        ...base({ eventId: `aether:${taskId}:warn:${key}`, createdAt }),
        type: "runtime.warning",
        payload: { message, ...(detail !== undefined ? { detail } : {}) },
      },
    ];
  };

  // -- message items --------------------------------------------------------

  const messageItemCompleted = (input: {
    readonly canonicalId: string;
    readonly itemType: "assistant_message" | "reasoning";
    readonly content: string;
    readonly wireTurnId: string | undefined;
    readonly createdAt: string;
  }): ReadonlyArray<ProviderRuntimeEvent> => {
    if (completedItems.has(input.canonicalId)) {
      return [];
    }
    completedItems.add(input.canonicalId);
    const detail = trimmedOrUndefined(input.content);
    return [
      {
        ...base({
          eventId: `aether:${taskId}:item:${input.canonicalId}`,
          createdAt: input.createdAt,
          wireTurnId: input.wireTurnId,
          itemId: input.canonicalId,
        }),
        type: "item.completed",
        payload: {
          itemType: input.itemType,
          status: "completed",
          ...(detail !== undefined ? { detail } : {}),
        },
      },
    ];
  };

  // -- tool lifecycle --------------------------------------------------------

  interface ToolUpdate {
    readonly toolCallId: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
    readonly status: string;
    readonly itemType: string | undefined;
    readonly label: string;
    readonly blocks: ReadonlyArray<unknown> | undefined;
    readonly result: string | undefined;
    readonly error: string | undefined;
    readonly wireTurnId: string | undefined;
    readonly createdAt: string;
  }

  const toolData = (update: ToolUpdate, terminal: TerminalBlockView | undefined): unknown => {
    const itemType7 = toolLifecycleItemTypeFromAether(update.itemType ?? "unknown");
    if (itemType7 === "file_change") {
      // The vendored parser understands every input shape the Aether
      // normalizers emit (codex files[] with oldContent/newContent/diff,
      // claude Edit/Write raw passthrough) and merges result-borne diffs.
      // `data.files[].path` is a nesting t3's extractChangedFiles walks.
      const files = parseFileChanges(update.input, update.result)
        .map((change) => change.path)
        .filter((path): path is string => path !== null)
        .map((path) => ({ path }));
      return { toolCallId: update.toolCallId, files };
    }
    if (itemType7 === "command_execution") {
      const command = readString(update.input, "command") ?? terminal?.command ?? update.label;
      const cwd = readString(update.input, "cwd");
      return {
        toolCallId: update.toolCallId,
        item: { command, ...(cwd !== undefined ? { cwd } : {}) },
      };
    }
    const mcpMatch = MCP_TOOL_NAME_RE.exec(update.name);
    if (itemType7 === "mcp_tool_call" && mcpMatch !== null) {
      return {
        toolCallId: update.toolCallId,
        item: {
          server: mcpMatch[1],
          tool: mcpMatch[2],
          args: update.input,
          ...(update.result !== undefined ? { result: update.result } : {}),
        },
      };
    }
    return {
      toolCallId: update.toolCallId,
      item: { name: update.name, input: update.input },
    };
  };

  const toolDetail = (
    update: ToolUpdate,
    terminal: TerminalBlockView | undefined,
  ): string | undefined => {
    const itemType7 = toolLifecycleItemTypeFromAether(update.itemType ?? "unknown");
    if (itemType7 !== "command_execution") {
      return trimmedOrUndefined(update.error);
    }
    const command = readString(update.input, "command") ?? terminal?.command ?? update.label;
    const output = terminal?.stdout ?? update.result;
    const parts = [command];
    if (output !== undefined && output.trim().length > 0) {
      parts.push(output);
    }
    // Exit-code marker: only when the terminal display block carries a
    // nonzero exit code (spec §2.1 command_execution row).
    if (terminal?.exitCode !== undefined && terminal.exitCode !== 0) {
      parts.push(`<exited with exit code ${terminal.exitCode}>`);
    }
    return trimmedOrUndefined(parts.join("\n"));
  };

  const mapToolUpdate = (
    update: ToolUpdate,
    source: "live" | "durable",
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    const statusKey = `${update.toolCallId}:${update.status}`;
    // Durable-wins for tool lifecycle: a durable row replay of a pair already
    // emitted (live or durable) is a strict data downgrade — same
    // deterministic eventId, but display blocks are absent on the REST
    // projection at this boundary (and its turnId is only inferred), and t3's
    // projector replaces the stored activity wholesale on id match. Live
    // re-emits stay through: the wire upserts full state last-write-wins.
    if (source === "durable" && emittedToolStatuses.has(statusKey)) {
      return [];
    }
    emittedToolStatuses.add(statusKey);
    const turnEvents = trackTurn(update.wireTurnId, update.createdAt);
    const itemStatus = runtimeItemStatusFromAether(update.status);
    const isTerminalStatus = itemStatus !== "inProgress";
    const firstSighting = !seenTools.has(update.toolCallId);
    seenTools.add(update.toolCallId);

    const type = isTerminalStatus
      ? "item.completed"
      : firstSighting
        ? "item.started"
        : "item.updated";
    const terminal = readTerminalBlock(update.blocks);
    const detail = toolDetail(update, terminal);
    const events: Array<ProviderRuntimeEvent> = [
      ...turnEvents,
      {
        // (toolCallId, wire status) keys the lifecycle: full-state re-emits
        // are last-write-wins on the same id — idempotent at ingestion.
        ...base({
          eventId: `aether:${taskId}:tool:${update.toolCallId}:${update.status}`,
          createdAt: update.createdAt,
          wireTurnId: update.wireTurnId,
          itemId: update.toolCallId,
        }),
        type,
        payload: {
          itemType: toolLifecycleItemTypeFromAether(update.itemType ?? "unknown"),
          status: itemStatus,
          ...(trimmedOrUndefined(update.label) !== undefined
            ? { title: trimmedOrUndefined(update.label) }
            : {}),
          ...(detail !== undefined ? { detail } : {}),
          data: toolData(update, terminal),
        },
      },
    ];

    if (itemStatus === "declined") {
      events.push({
        ...base({
          eventId: `aether:${taskId}:tool:${update.toolCallId}:${update.status}:denied`,
          createdAt: update.createdAt,
          wireTurnId: update.wireTurnId,
        }),
        type: "tool.denied",
        payload: {
          toolName: update.name,
          toolUseId: update.toolCallId,
          ...(trimmedOrUndefined(update.error) !== undefined
            ? { reason: trimmedOrUndefined(update.error) }
            : {}),
        },
      });
    }

    const todos = readTodoItems(update.blocks);
    if (todos.length > 0) {
      events.push({
        ...base({
          eventId: `aether:${taskId}:tool:${update.toolCallId}:${update.status}:plan`,
          createdAt: update.createdAt,
          wireTurnId: update.wireTurnId,
        }),
        type: "turn.plan.updated",
        payload: { plan: todos },
      });
    }
    return events;
  };

  const toolUpdateFromWs = (
    toolCallId: string,
    payload: AetherWsToolPayload,
    wireTurnId: string | undefined,
    createdAt: string,
  ): ToolUpdate => ({
    toolCallId,
    name: payload.name,
    input: payload.input,
    status: payload.status,
    itemType: payload.itemType,
    label: payload.display.label,
    blocks: payload.display.blocks,
    result: payload.result,
    error: payload.error,
    wireTurnId,
    createdAt,
  });

  const toolUpdateFromRow = (
    tool: AetherTimelineTool,
    wireTurnId: string | undefined,
    createdAt: string,
  ): ToolUpdate => ({
    toolCallId: tool.id,
    name: tool.name,
    input: tool.input,
    status: tool.status,
    itemType: tool.itemType,
    label: tool.display.label,
    // The REST projection carries no display blocks at this boundary — the
    // command detail falls back to the result string.
    blocks: undefined,
    result: tool.result,
    error: tool.error,
    // Durable rows carry no turn field; the caller attributes them (see
    // reconcileDelta's active-turn boundary).
    wireTurnId,
    createdAt,
  });

  // -- turn settles & pending inputs ----------------------------------------

  const settleTurn = (input: {
    readonly wireTurnId: string;
    readonly state: "completed" | "failed";
    readonly errorMessage?: string | undefined;
    readonly createdAt: string;
  }): ReadonlyArray<ProviderRuntimeEvent> => {
    // Exactly one terminal settle per turn. For a grounded turn this is
    // DURABLE-AUTHORITATIVE — only the durable reconcile paths (reconcileTask
    // awaiting_input/errored, trackTurn's displaced-predecessor transition,
    // noteTurnStarted) reach here; the live turn.* frames are suppressed
    // upstream. The cold mapper-only path still settles from the live frame.
    if (settledTurns.has(input.wireTurnId)) {
      return [];
    }
    settledTurns.add(input.wireTurnId);
    if (activeWireTurnId === input.wireTurnId) {
      activeWireTurnId = undefined;
    }
    // A user-interrupted turn settles as `interrupted` no matter which
    // transport observes the settle (spec §2.3 interrupt row).
    const state: "completed" | "failed" | "interrupted" = interruptedTurns.has(input.wireTurnId)
      ? "interrupted"
      : input.state;
    // Ingestion flips the session to error/ready on a turn settle; mirror it
    // so the status projection re-emits `running` for the NEXT turn.
    lastProjectedState = state === "failed" ? "error" : "ready";
    const errorMessage = trimmedOrUndefined(input.errorMessage);
    return [
      {
        ...base({
          eventId: `aether:${taskId}:turn:${input.wireTurnId}:settled`,
          createdAt: input.createdAt,
          wireTurnId: input.wireTurnId,
        }),
        type: "turn.completed",
        payload: {
          state,
          ...(errorMessage !== undefined ? { errorMessage } : {}),
        },
      },
    ];
  };

  /**
   * Close the open pending-input slot and emit its resolution. ask_user
   * inputs pair `user-input.requested` with `user-input.resolved` (t3 clears
   * the composer panel from it); plan cards have no resolution event — the
   * follow-up turn's own lifecycle supersedes the banner.
   */
  const resolveOpenInput = (
    answers: Record<string, unknown>,
    createdAt: string,
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    if (openInput === undefined) {
      return [];
    }
    const resolved = openInput;
    openInput = undefined;
    if (resolved.toolName !== "ask_user") {
      return [];
    }
    return [
      {
        ...base({
          eventId: `aether:${taskId}:input:${resolved.pendingId}:resolved`,
          createdAt,
          wireTurnId: resolved.wireTurnId,
          requestId: resolved.pendingId,
        }),
        type: "user-input.resolved",
        payload: { answers },
      },
    ];
  };

  const pendingInput = (input: {
    readonly pendingId: string;
    readonly toolName: "ask_user" | "propose_plan";
    readonly payload: Record<string, unknown>;
    readonly wireTurnId: string | undefined;
    readonly createdAt: string;
  }): ReadonlyArray<ProviderRuntimeEvent> => {
    // pendingInputId (WS) and tool_id (REST) name the same pending input —
    // exactly one user-input.requested / plan card per id across transports.
    if (requestedInputs.has(input.pendingId)) {
      return [];
    }
    const events: Array<ProviderRuntimeEvent> = [];
    // Aether holds ONE pending input per task: a new callback overwrites the
    // slot wholesale, so a different id arriving means the previous input
    // was superseded remotely — resolve it before surfacing the new one.
    if (openInput !== undefined && openInput.pendingId !== input.pendingId) {
      events.push(...resolveOpenInput({}, input.createdAt));
    }

    if (input.toolName === "ask_user") {
      const { questions, issues, answerable } = parseAetherQuestions(input.payload);
      if (issues.length > 0) {
        events.push(
          ...warningOnce(
            `input:${input.pendingId}:malformed`,
            "Aether asked a question t3 could not fully parse.",
            { issues },
            input.createdAt,
          ),
        );
      }
      if (questions.length === 0) {
        // Nothing renderable: the warning above is the loud surface. Do NOT
        // mark the input consumed — a later, better-formed twin may land.
        return events;
      }
      requestedInputs.add(input.pendingId);
      openInput = {
        pendingId: input.pendingId,
        toolName: "ask_user",
        wireTurnId: input.wireTurnId,
        questions: answerable,
      };
      events.push({
        ...base({
          eventId: `aether:${taskId}:input:${input.pendingId}`,
          createdAt: input.createdAt,
          wireTurnId: input.wireTurnId,
          requestId: input.pendingId,
        }),
        type: "user-input.requested",
        payload: { questions },
      });
    } else {
      const plan = trimmedOrUndefined(readString(input.payload, "plan"));
      if (plan === undefined) {
        events.push(
          ...warningOnce(
            `input:${input.pendingId}:malformed`,
            "Aether proposed a plan with no plan markdown.",
            { input: input.payload },
            input.createdAt,
          ),
        );
        return events;
      }
      requestedInputs.add(input.pendingId);
      openInput = {
        pendingId: input.pendingId,
        toolName: "propose_plan",
        wireTurnId: input.wireTurnId,
        questions: [],
      };
      events.push({
        ...base({
          eventId: `aether:${taskId}:input:${input.pendingId}`,
          createdAt: input.createdAt,
          wireTurnId: input.wireTurnId,
          requestId: input.pendingId,
        }),
        type: "turn.proposed.completed",
        payload: { planMarkdown: plan },
      });
    }

    // An actually-pending question/plan is the ONLY state that maps to
    // `waiting` (t3 projects waiting→running; the message-kind idle state
    // must stay READY with no emission — spec resolved note 2).
    lastProjectedState = "waiting";
    events.push({
      ...base({
        eventId: `aether:${taskId}:input:${input.pendingId}:waiting`,
        createdAt: input.createdAt,
        requestId: input.pendingId,
      }),
      type: "session.state.changed",
      payload: { state: "waiting", reason: "Aether is waiting for your input." },
    });
    return events;
  };

  // -- WS events -------------------------------------------------------------

  const mapWsEvent = (
    event: AetherAgentEvent,
    nowIso: string,
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    const createdAt = stamp(event.createdAt, nowIso);
    switch (event.kind) {
      case "tool_call.started":
      case "tool_call.completed":
      case "tool_call.failed":
        return mapToolUpdate(
          toolUpdateFromWs(
            event.toolCallId,
            event.payload,
            resolveLiveWireTurnId(event.turnId),
            createdAt,
          ),
          "live",
        );

      case "assistant_message.delta": {
        const canonicalId = canonicalMessageItemId(event.messageId);
        // Durable-wins applies to the STREAM too: live frames queue from the
        // moment the socket opens but drain only after the reconnect
        // reconciliation, so a delta whose item.completed twin was already
        // ingested from the durable snapshot is a stale replay — emitting it
        // would re-open or extend a finalized bubble (its live turn.completed
        // twin is swallowed by settledTurns, so nothing would close it).
        if (completedItems.has(canonicalId)) {
          return [];
        }
        const wireTurnId = resolveLiveWireTurnId(event.turnId);
        const turnEvents = trackTurn(wireTurnId, createdAt);
        const counter = (deltaCounters.get(canonicalId) ?? 0) + 1;
        deltaCounters.set(canonicalId, counter);
        return [
          ...turnEvents,
          {
            ...base({
              eventId: `aether:${taskId}:stream:${canonicalId}:${counter}`,
              createdAt,
              wireTurnId,
              itemId: canonicalId,
            }),
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta: event.payload.delta },
          },
        ];
      }

      case "thinking.delta": {
        const canonicalId = canonicalThinkingItemId(event.messageId);
        // Same stale-replay gate as assistant deltas (durable wins).
        if (completedItems.has(canonicalId)) {
          return [];
        }
        const wireTurnId = resolveLiveWireTurnId(event.turnId);
        const turnEvents = trackTurn(wireTurnId, createdAt);
        const counter = (deltaCounters.get(canonicalId) ?? 0) + 1;
        deltaCounters.set(canonicalId, counter);
        return [
          ...turnEvents,
          {
            ...base({
              eventId: `aether:${taskId}:stream:${canonicalId}:${counter}`,
              createdAt,
              wireTurnId,
              itemId: canonicalId,
            }),
            // NEVER assistant_text: remapping thinking into the assistant
            // stream renders reasoning as commentary (spec §2.1 thinking row).
            type: "content.delta",
            payload: { streamKind: "reasoning_text", delta: event.payload.delta },
          },
        ];
      }

      // A stream boundary marker; the *.completed twins carry the content.
      case "stream.complete":
        return [];

      case "assistant_message.completed": {
        const wireTurnId = resolveLiveWireTurnId(event.turnId);
        return [
          ...trackTurn(wireTurnId, createdAt),
          ...messageItemCompleted({
            canonicalId: canonicalMessageItemId(event.messageId),
            itemType: "assistant_message",
            content: event.payload.content,
            wireTurnId,
            createdAt,
          }),
        ];
      }

      case "thinking.completed": {
        const wireTurnId = resolveLiveWireTurnId(event.turnId);
        return [
          ...trackTurn(wireTurnId, createdAt),
          ...messageItemCompleted({
            canonicalId: canonicalThinkingItemId(event.messageId),
            itemType: "reasoning",
            content: event.payload.content,
            wireTurnId,
            createdAt,
          }),
        ];
      }

      case "turn.completed": {
        const wireTurnId = resolveLiveWireTurnId(event.turnId);
        // Durable-authoritative settlement: a grounded turn is settled ONLY by
        // the durable reconcile observing the task-status flip. The live
        // random-id frame just attributes ownership here; the adapter uses it
        // as a trigger to fire the durable reconcile immediately (low latency).
        if (durableTurns.has(wireTurnId)) {
          return trackTurn(wireTurnId, createdAt);
        }
        // Cold mapper-only path (no durable turn ever grounded): the live
        // settle is the only terminator, so keep it.
        return [
          ...trackTurn(wireTurnId, createdAt),
          ...settleTurn({ wireTurnId, state: "completed", createdAt }),
        ];
      }

      case "turn.failed": {
        const wireTurnId = resolveLiveWireTurnId(event.turnId);
        // Grounded: the durable reconcileTask "errored" path owns both the
        // failed settle AND the runtime.error card. A live turn.failed that
        // does not actually error the task must not fabricate an error card.
        if (durableTurns.has(wireTurnId)) {
          return trackTurn(wireTurnId, createdAt);
        }
        if (interruptedTurns.has(wireTurnId)) {
          // A stop often surfaces remotely as a failed turn; the user asked
          // for it, so no error card — just the interrupted settle.
          return [
            ...trackTurn(wireTurnId, createdAt),
            ...settleTurn({ wireTurnId, state: "failed", createdAt }),
          ];
        }
        return [
          ...trackTurn(wireTurnId, createdAt),
          ...settleTurn({
            wireTurnId,
            state: "failed",
            errorMessage: event.payload.errorMessage,
            createdAt,
          }),
          {
            // Deliberately NO turnId here (matching the REST errored path):
            // ingestion's runtime.error branch reinstates
            // `activeTurnId = event.turnId ?? null` AFTER the settle just
            // cleared it, which would wedge the session on a settled turn and
            // make the conflict guard drop every later turn.completed.
            ...base({
              eventId: `aether:${taskId}:turn:${wireTurnId}:error`,
              createdAt,
            }),
            type: "runtime.error",
            payload: { message: event.payload.errorMessage, class: "provider_error" },
          },
        ];
      }

      case "turn.awaiting_input": {
        // An awaiting_input IS a settle: the remote turn ended and parked on
        // a pending input. Dispatch on payload.toolName (the live shape has
        // no `kind` — spec resolved note 12).
        const wireTurnId = resolveLiveWireTurnId(event.turnId);
        // Grounded: the durable reconcileTask "awaiting_input" branch owns
        // both the settle AND re-surfacing the pending input (deduped by
        // settledTurns/requestedInputs). The adapter's immediate reconcile
        // trigger keeps the question/plan prompt latency low.
        if (durableTurns.has(wireTurnId)) {
          return trackTurn(wireTurnId, createdAt);
        }
        const settle = [
          ...trackTurn(wireTurnId, createdAt),
          ...settleTurn({ wireTurnId, state: "completed", createdAt }),
        ];
        switch (event.payload.toolName) {
          case "ask_user":
            return [
              ...settle,
              ...pendingInput({
                pendingId: event.pendingInputId,
                toolName: "ask_user",
                payload: event.payload.input,
                wireTurnId,
                createdAt,
              }),
            ];
          case "propose_plan":
            return [
              ...settle,
              ...pendingInput({
                pendingId: event.pendingInputId,
                toolName: "propose_plan",
                payload: event.payload.input,
                wireTurnId,
                createdAt,
              }),
            ];
          case "stop_task":
            // Settle only: no prompt, no composer panel (spec §2.1 live row).
            return settle;
          default:
            return [
              ...settle,
              ...warningOnce(
                `awaiting-tool:${event.payload.toolName}`,
                `Aether reported an unknown pending-input tool '${event.payload.toolName}'. The task is waiting for input t3 cannot render — respond from the Aether app.`,
                undefined,
                createdAt,
              ),
            ];
        }
      }

      case "conversation.truncated":
        // No t3 event means "the remote conversation was truncated" (revert /
        // rewind): thread.state values (compacted/closed/…) all misstate it,
        // so surface a visible warning; the durable delta refetch on the next
        // reconcile carries the actual removals (spec §2.1 runtime.warning row).
        return [
          {
            ...base({
              eventId: `aether:${taskId}:truncated:${event.payload.anchorMessageId}`,
              createdAt,
            }),
            type: "runtime.warning",
            payload: {
              message: "Aether truncated the remote conversation (a revert or rewind).",
              detail: { anchorMessageId: event.payload.anchorMessageId },
            },
          },
        ];

      // No t3 slash-command surface for cloud sessions; the caller logs once.
      case "slash_commands.updated":
        return [];
    }
  };

  // -- durable reconciliation -------------------------------------------------

  const reconcileTask = (task: AetherTask, nowIso: string): ReadonlyArray<ProviderRuntimeEvent> => {
    const createdAt = stamp(undefined, nowIso);
    switch (task.status) {
      // Status projection (spec §2.1 working-indicator row, must):
      // queued→starting, processing→running — without these a passive resume
      // onto a mid-turn task shows an idle thread receiving assistant output.
      // A bare queued/processing observation is NOT proof an open input was
      // answered out of band: the workspace emits the live
      // turn.awaiting_input BEFORE the API transaction that parks the task
      // row commits (handler.ts emits, then flushes the question callback —
      // a failed flush widens the window to its replay), so a reconcile beat
      // landing in that window still reads the pre-park status. Resolving
      // here would permanently suppress the question (`requestedInputs`
      // dedupes re-surfacing) and wedge the thread: Aether 409s a plain
      // respond while awaiting questions/plan. A GENUINE out-of-band answer
      // always surfaces harder evidence — the answering user row /
      // `activeProcessingTurn` names a DIFFERENT wire turn (trackTurn
      // resolves the input, build item 14), or the task lands on an advanced
      // state (awaiting_input / errored, handled below). Until that evidence
      // arrives, leave the panel and the `waiting` projection untouched.
      case "queued":
        return openInput !== undefined
          ? []
          : projectSessionState(
              "starting",
              "Aether queued the task; waiting for a workspace.",
              createdAt,
            );
      case "processing":
        return openInput !== undefined ? [] : projectSessionState("running", undefined, createdAt);

      case "awaiting_input": {
        const events: Array<ProviderRuntimeEvent> = [];
        // The pending input belongs to the turn that ASKED — capture it
        // before the settle clears the tracking, so the request event lands
        // owned (the WS twin carries the same pairing).
        const requestWireTurnId = activeWireTurnId;
        // A task at awaiting_input has no turn in flight: settle a tracked
        // one that never saw its live-only turn.* event (missed settles are
        // recoverable ONLY here — spec §2.1 turn-settle row).
        if (activeWireTurnId !== undefined) {
          events.push(
            ...settleTurn({ wireTurnId: activeWireTurnId, state: "completed", createdAt }),
          );
        }
        switch (task.awaiting_input.kind) {
          case "message":
            // The idle state between EVERY pair of turns: session READY,
            // deliberately NO state emission (spec resolved note 2). An open
            // input observed here was answered out of band; when nothing
            // else corrects the projected `waiting` (no tracked turn to
            // settle), the explicit READY emission does.
            if (openInput !== undefined) {
              events.push(...resolveOpenInput({}, createdAt));
              if (lastProjectedState === "waiting") {
                lastProjectedState = "ready";
                stateEmissions++;
                events.push({
                  ...base({
                    eventId: `aether:${taskId}:state:${stateEmissions}:ready`,
                    createdAt,
                  }),
                  type: "session.state.changed",
                  payload: { state: "ready" },
                });
              }
            }
            return events;
          case "questions":
            return [
              ...events,
              ...pendingInput({
                pendingId: task.awaiting_input.tool_id,
                toolName: "ask_user",
                payload: isRecord(task.awaiting_input.input) ? task.awaiting_input.input : {},
                wireTurnId: requestWireTurnId,
                createdAt,
              }),
            ];
          case "plan":
            return [
              ...events,
              ...pendingInput({
                pendingId: task.awaiting_input.tool_id,
                toolName: "propose_plan",
                payload: isRecord(task.awaiting_input.input) ? task.awaiting_input.input : {},
                wireTurnId: requestWireTurnId,
                createdAt,
              }),
            ];
          case "unknown-kind":
            return [
              ...events,
              ...warningOnce(
                `awaiting-kind:${task.awaiting_input.rawKind}`,
                `Aether reported an unrecognized awaiting-input kind '${task.awaiting_input.rawKind}'. The task is waiting for input t3 cannot render — respond from the Aether app.`,
                undefined,
                createdAt,
              ),
            ];
        }
        // Exhaustive switch above; unreachable.
        return events;
      }

      case "errored": {
        const events: Array<ProviderRuntimeEvent> = [];
        // An errored task no longer waits on anything — clear a stale panel.
        events.push(...resolveOpenInput({}, createdAt));
        if (activeWireTurnId !== undefined) {
          events.push(
            ...settleTurn({
              wireTurnId: activeWireTurnId,
              state: "failed",
              errorMessage: task.error,
              createdAt,
            }),
          );
        }
        if (!taskErrorEmitted) {
          taskErrorEmitted = true;
          events.push({
            ...base({ eventId: `aether:${taskId}:errored`, createdAt }),
            type: "runtime.error",
            payload: { message: task.error, class: "provider_error" },
          });
        }
        // errored→error (spec §2.1 working-indicator row). When a tracked
        // turn just settled as failed, settleTurn already mirrored the error
        // state and this emits nothing; it fires for a COLD observation of an
        // errored task (resume with no turn in flight).
        events.push(...projectSessionState("error", task.error, createdAt));
        return events;
      }

      case "unknown-status":
        return warningOnce(
          `status:${task.rawStatus}`,
          `Aether reported an unrecognized task status '${task.rawStatus}'. Live updates may be incomplete until t3's Aether driver is updated.`,
          undefined,
          createdAt,
        );
    }
  };

  const reconcileDelta = (
    delta: AetherConversationDelta,
    nowIso: string,
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    const events: Array<ProviderRuntimeEvent> = [];

    if (delta.truncated) {
      events.push(
        ...warningOnce(
          `delta-truncated:${lastSequence}`,
          "Aether's change feed was truncated; some intermediate updates were skipped.",
          undefined,
          stamp(undefined, nowIso),
        ),
      );
    }

    const rows = [...delta.messages].sort((left, right) => left.sequence - right.sequence);
    // Durable rows carry no turn field. Attribution walks the batch with a
    // running opener: the wire turn id IS the opening user row (the mapper's
    // core invariant), so a delivered user row opens the turn every
    // subsequent row belongs to — including the awaiting_input resume case
    // where activeProcessingTurn is already null. Queued/cancelled user rows
    // are NOT openers: they park in the timeline ahead of their turn while
    // the current one still streams. Rows before the first opener fall back
    // to the turn the mapper already tracks (warm reconcile across a turn
    // transition), and a batch with no opener at all sits mid-turn, so the
    // delta's activeProcessingTurn owns it (opener consumed by an earlier
    // delta). A cold mapper with none of the three leaves rows unowned —
    // attribution would be a guess.
    const activeWireTurnIdForRows = delta.activeProcessingTurn?.messageId;
    // Both durable turn-identity sources — an opening user row and
    // activeProcessingTurn — ground the live→durable alias resolver.
    noteDurableTurn(activeWireTurnIdForRows);
    const isTurnOpener = (row: (typeof rows)[number]): boolean =>
      row.role === "user" && row.deliveryStatus !== "queued" && row.deliveryStatus !== "cancelled";
    let runningWireTurnId = activeWireTurnId;
    if (runningWireTurnId === undefined && !rows.some(isTurnOpener)) {
      runningWireTurnId = activeWireTurnIdForRows;
    }

    for (const row of rows) {
      if (row.sequence <= lastSequence) {
        continue;
      }
      lastSequence = row.sequence;
      const createdAt = stamp(row.timestamp, nowIso);
      if (row.role === "user") {
        // t3 persists user bubbles only from its own thread.turn.start;
        // remote-originated turn detection is build item 13, and answered
        // tool responses resolve in T7. Rows still advance the cursor —
        // and delivered openers move the running turn so later rows (and
        // reconcileTask's pending-input events) are owned even on a cold
        // resume to an already-awaiting task.
        if (isTurnOpener(row)) {
          runningWireTurnId = row.id;
          noteDurableTurn(runningWireTurnId);
          events.push(...trackTurn(runningWireTurnId, createdAt));
        }
        continue;
      }
      const wireTurnId = runningWireTurnId;
      switch (row.variant) {
        case "text":
          events.push(
            ...trackTurn(wireTurnId, createdAt),
            ...messageItemCompleted({
              canonicalId: canonicalMessageItemId(row.id),
              itemType: "assistant_message",
              content: row.content,
              wireTurnId,
              createdAt,
            }),
          );
          break;
        case "thinking":
          events.push(
            ...trackTurn(wireTurnId, createdAt),
            ...messageItemCompleted({
              canonicalId: canonicalThinkingItemId(row.id),
              itemType: "reasoning",
              content: row.content,
              wireTurnId,
              createdAt,
            }),
          );
          break;
        case "tool":
          events.push(
            ...mapToolUpdate(toolUpdateFromRow(row.tool, wireTurnId, createdAt), "durable"),
          );
          break;
        case "seam":
          // The compaction seam is durable-ONLY (never live) and maps to
          // t3's compacted thread state (spec §2.1 'Context compacted' row).
          // Other seam reasons (teleport, …) have no t3 semantic.
          if (row.seam.reason === "compaction") {
            events.push({
              ...base({ eventId: `aether:${taskId}:seq:${row.sequence}`, createdAt }),
              type: "thread.state.changed",
              payload: { state: "compacted" },
            });
          }
          break;
      }
    }

    if (delta.latestSequence > lastSequence) {
      lastSequence = delta.latestSequence;
    }
    if (delta.activeProcessingTurn !== null) {
      // The wire turn id is the user message id that opened the turn. A turn
      // TRANSITION observed here (awaiting_input→processing skipped between
      // observations) settles the displaced predecessor — see trackTurn. An
      // attributed row above already opened the turn (this is then a no-op);
      // this covers the status-flip-with-no-new-rows observation.
      events.push(
        ...trackTurn(
          delta.activeProcessingTurn.messageId,
          stamp(delta.activeProcessingTurn.startedAt, nowIso),
        ),
      );
    }
    events.push(...reconcileTask(delta.task, nowIso));
    return events;
  };

  return {
    mapWsEvent,
    reconcileDelta,
    reconcileTask,
    latestSequence: () => lastSequence,
    activeWireTurnId: () => activeWireTurnId,
    isOwnLiveTurnId,
    noteTurnStarted: (wireTurnId, nowIso) => {
      // A driver-initiated turn: the durable turn identity every subsequent
      // live frame's random per-dispatch id must resolve to.
      noteDurableTurn(wireTurnId);
      return trackTurn(wireTurnId, stamp(undefined, nowIso));
    },
    markInterrupted: (wireTurnId) => {
      interruptedTurns.add(wireTurnId);
    },
    openUserInput: () => openInput,
    noteInputResolved: (pendingId, answers, nowIso) =>
      openInput !== undefined && openInput.pendingId === pendingId
        ? resolveOpenInput(answers, stamp(undefined, nowIso))
        : [],
  };
}
