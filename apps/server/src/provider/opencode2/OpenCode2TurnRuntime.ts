/**
 * OpenCode2TurnRuntime — turn submission for the standalone `opencode2`
 * adapter.
 *
 * `sendOpenCode2Turn` validates the model selection, resolves file parts,
 * applies v2-native in-session model/agent switches (`switchModel` /
 * `switchAgent`), submits the prompt (or native slash command) with a 10s
 * admission budget, and emits the `turn.started` event. `completeOpenCode2Turn`
 * / `abortOpenCode2Turn` settle the turn when the event pump observes the
 * translator's terminal frames (`session.execution.succeeded` /
 * `session.execution.failed` → completed, `session.execution.interrupted` →
 * aborted); `interruptOpenCode2Turn` prefers native `session.interrupt` with
 * the structural `session.abort` as fallback (10s budget).
 *
 * @module provider/opencode2/OpenCode2TurnRuntime
 */
import type {
  ChatAttachment,
  EventId,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ThreadTokenUsageSnapshot,
  TurnId,
  TurnTokenUsage,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import {
  openCode2RequestError,
  openCode2ValidationError,
  parseOpenCode2ModelSlug,
  toOpenCode2FileParts,
  type OpenCode2AdapterError,
} from "./OpenCode2Protocol.ts";
import {
  accumulateOpenCode2TurnUsage,
  ensureOpenCode2Context,
  abortOpenCode2Descendants,
  OPENCODE2_COMPACTION_TIMEOUT_MS,
  OPENCODE2_TEARDOWN_TIMEOUT_MS,
  resetOpenCode2TurnUsage,
  runOpenCode2SdkWithTimeout,
  takeOpenCode2TurnUsage,
  withOpenCode2SubmissionTimeout,
  type OpenCode2SessionContext,
  type OpenCode2SessionStore,
} from "./OpenCode2SessionStore.ts";

export interface OpenCode2SendTurnDeps {
  readonly boundInstanceId: ProviderSession["providerInstanceId"];
  readonly attachmentsDir: string;
  readonly resolveAttachmentPath: (input: {
    readonly attachmentsDir: string;
    readonly attachment: ChatAttachment;
  }) => string | null;
  readonly instructions?: string | undefined;
  readonly defaultAgent?: string | undefined;
  readonly randomTurnId: Effect.Effect<string>;
  readonly randomMessageId: Effect.Effect<string>;
  readonly randomEventId: Effect.Effect<string>;
  readonly nowIso: Effect.Effect<string>;
  /** Known native slash commands for `command` submission (empty = prompts only). */
  readonly loadCommands?: (
    store: OpenCode2SessionStore,
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<{ readonly name: string }>, OpenCode2AdapterError>;
  readonly listSlashCommands?:
    | ReadonlyArray<{ readonly name: string; readonly description?: string | undefined }>
    | undefined;
}

/**
 * Bound an SDK call with the 10s submission budget. Timeouts surface as
 * `ProviderAdapterRequestError`; the v1 adapter uses the same budget and
 * the same typed failure for prompt/command/abort submission. Canonical
 * budget lives in `OpenCode2SessionStore.ts`
 * (`OPENCODE2_SUBMISSION_TIMEOUT_MS`).
 */
const withSubmissionTimeout = withOpenCode2SubmissionTimeout;

/**
 * Model/variant last applied to the remote session via `switchModel`.
 * `session.create` never sends the start selection and `session.model` only
 * records what was requested, so gating the switch on it skips the first
 * turn (the recorded model already matches) and variant-only changes. The
 * session id rides along because rollback forks a new session onto the same
 * context object, which must force a re-apply.
 */
interface OpenCode2AppliedModel {
  readonly sessionId: string;
  readonly model: string;
  readonly variant: string | undefined;
}

const appliedOpenCode2Model = new WeakMap<OpenCode2SessionContext, OpenCode2AppliedModel>();

const needsOpenCode2ModelSwitch = (
  context: OpenCode2SessionContext,
  model: string,
  variant: string | undefined,
): boolean => {
  const applied = appliedOpenCode2Model.get(context);
  return (
    applied === undefined ||
    applied.sessionId !== context.openCodeSessionId ||
    applied.model !== model ||
    applied.variant !== variant
  );
};

const recordOpenCode2ModelSwitch = (
  context: OpenCode2SessionContext,
  model: string,
  variant: string | undefined,
): void => {
  appliedOpenCode2Model.set(context, {
    sessionId: context.openCodeSessionId,
    model,
    variant,
  });
};

const emitTurnStarted = (
  events: Queue.Enqueue<ProviderRuntimeEvent>,
  input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly model: string | undefined;
    readonly providerInstanceId: ProviderSession["providerInstanceId"];
    readonly eventId: EventId;
    readonly createdAt: string;
  },
): Effect.Effect<void> =>
  Queue.offer(events, {
    eventId: input.eventId,
    provider: "opencode2" as ProviderRuntimeEvent["provider"],
    ...(input.providerInstanceId !== undefined
      ? { providerInstanceId: input.providerInstanceId }
      : {}),
    threadId: input.threadId,
    createdAt: input.createdAt,
    turnId: input.turnId,
    type: "turn.started",
    payload: input.model !== undefined ? { model: input.model } : {},
  } as unknown as ProviderRuntimeEvent).pipe(Effect.asVoid);

/**
 * Send a turn: validate selection, switch model/agent in-session when the
 * selection names them, submit prompt (or native command) within the
 * admission budget, mark the session running, and emit `turn.started`.
 *
 * Concurrency: submissions serialize on the per-context `promptSemaphore`
 * (v1 `promptSemaphore.withPermit` parity). The boolean fast-path rejects
 * an obviously-overlapping caller without queueing; the semaphore is the
 * real guard — it closes the check-then-act race where two fibers both see
 * a clear flag and submit concurrently, and it serializes interleavings
 * the flag alone cannot (validation yields between the flag check and the
 * submit). Steering (send while a turn is active) still queues into the
 * running session inside the permit; the semaphore only serializes the
 * submission window, not the turn lifetime.
 */
export const sendOpenCode2Turn = Effect.fn("sendOpenCode2Turn")(function* (
  store: OpenCode2SessionStore,
  events: Queue.Enqueue<ProviderRuntimeEvent>,
  input: ProviderSendTurnInput,
  deps: OpenCode2SendTurnDeps,
): Effect.fn.Return<
  { readonly threadId: ThreadId; readonly turnId: TurnId; readonly resumeCursor: unknown },
  OpenCode2AdapterError
> {
  const context = yield* ensureOpenCode2Context(store, input.threadId);
  if (context.sendTurnInFlight) {
    return yield* openCode2ValidationError(
      "sendTurn",
      "OpenCode 2 is still submitting the previous turn; wait for it to finish before sending another.",
    );
  }
  return yield* context.promptSemaphore.withPermit(
    Effect.gen(function* () {
      // Re-check inside the permit: a waiter that queued behind an
      // in-flight submission must not submit twice into the same window.
      const current = yield* ensureOpenCode2Context(store, input.threadId);
      if (current !== context) {
        return yield* openCode2ValidationError(
          "sendTurn",
          "OpenCode 2 session changed while waiting to submit; retry the turn.",
        );
      }
      if (context.sendTurnInFlight) {
        return yield* openCode2ValidationError(
          "sendTurn",
          "OpenCode 2 is still submitting the previous turn; wait for it to finish before sending another.",
        );
      }
      context.sendTurnInFlight = true;
      try {
        return yield* submitOpenCode2Turn(store, events, input, deps);
      } finally {
        context.sendTurnInFlight = false;
      }
    }),
  );
});

/**
 * Send a turn: validate selection, switch model/agent in-session when the
 * selection names them, submit prompt (or native command) within the
 * admission budget, mark the session running, and emit `turn.started`.
 */
const submitOpenCode2Turn = Effect.fn("submitOpenCode2Turn")(function* (
  store: OpenCode2SessionStore,
  events: Queue.Enqueue<ProviderRuntimeEvent>,
  input: ProviderSendTurnInput,
  deps: OpenCode2SendTurnDeps,
): Effect.fn.Return<
  { readonly threadId: ThreadId; readonly turnId: TurnId; readonly resumeCursor: unknown },
  OpenCode2AdapterError
> {
  const context = yield* ensureOpenCode2Context(store, input.threadId);
  const modelSelection =
    input.modelSelection ??
    (context.session.model !== undefined && deps.boundInstanceId !== undefined
      ? { instanceId: deps.boundInstanceId, model: context.session.model }
      : undefined);
  if (
    modelSelection !== undefined &&
    deps.boundInstanceId !== undefined &&
    modelSelection.instanceId !== deps.boundInstanceId
  ) {
    return yield* openCode2ValidationError(
      "sendTurn",
      `OpenCode 2 model selection is bound to instance '${modelSelection.instanceId}', expected '${deps.boundInstanceId}'.`,
    );
  }
  const parsedModel = parseOpenCode2ModelSlug(modelSelection?.model);
  if (!parsedModel) {
    return yield* openCode2ValidationError(
      "sendTurn",
      "OpenCode 2 model selection must use the 'provider/model' format.",
    );
  }

  const text = input.input?.trim();
  const commandMatch = text?.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
  const knownCommands =
    deps.listSlashCommands ??
    (deps.loadCommands !== undefined
      ? yield* deps.loadCommands(store, input.threadId)
      : context.client.session.listCommands !== undefined
        ? yield* runOpenCode2SdkWithTimeout("command.list", (signal) =>
            context.client.session.listCommands!({ directory: context.directory }, { signal }),
          ).pipe(
            Effect.map((response) => response.data ?? []),
            Effect.orElseSucceed(() => [] as ReadonlyArray<{ readonly name: string }>),
          )
        : []);
  const nativeCommand =
    commandMatch !== undefined && commandMatch !== null
      ? knownCommands.find((command) => command.name === commandMatch[1])
      : undefined;
  const fileParts = toOpenCode2FileParts({
    attachments: input.attachments,
    resolveAttachmentPath: (attachment) =>
      deps.resolveAttachmentPath({ attachmentsDir: deps.attachmentsDir, attachment }),
  });
  if ((text === undefined || text.length === 0) && fileParts.length === 0) {
    return yield* openCode2ValidationError(
      "sendTurn",
      "OpenCode 2 turns require text input or at least one attachment.",
    );
  }

  // A sendTurn while a turn is active is a steer: OpenCode queues the prompt
  // into the running session, so the active turn id is reused and its usage
  // accumulator carries over.
  const steeringTurnId = context.activeTurnId;
  const agent = getModelSelectionStringOptionValue(modelSelection, "agent") ?? deps.defaultAgent;
  // Selection-options variant wins; otherwise fall back to the `#variant`
  // suffix parsed from the model slug (upstream switchModel takes
  // {providerID, id, variant}, so the slug itself is rebuilt clean below).
  const variant =
    getModelSelectionStringOptionValue(modelSelection, "variant") ?? parsedModel.variant;
  if (agent !== undefined && agent !== context.activeAgent) {
    yield* runOpenCode2SdkWithTimeout("session.switchAgent", (signal) =>
      context.client.session.switchAgent(
        { sessionID: context.openCodeSessionId, agent },
        { signal },
      ),
    ).pipe(withSubmissionTimeout("session.switchAgent"), Effect.asVoid);
  }
  const modelSlug = `${parsedModel.providerID}/${parsedModel.modelID}`;
  if (needsOpenCode2ModelSwitch(context, modelSlug, variant)) {
    yield* runOpenCode2SdkWithTimeout("session.switchModel", (signal) =>
      context.client.session.switchModel(
        {
          sessionID: context.openCodeSessionId,
          model: modelSlug,
          ...(variant !== undefined ? { variant } : {}),
        },
        { signal },
      ),
    ).pipe(withSubmissionTimeout("session.switchModel"), Effect.asVoid);
    recordOpenCode2ModelSwitch(context, modelSlug, variant);
  }

  const turnId = (steeringTurnId ?? `opencode2-turn-${yield* deps.randomTurnId}`) as TurnId;
  const messageId = yield* deps.randomMessageId;
  const effectiveAgent = agent ?? (input.interactionMode === "plan" ? "plan" : undefined);
  if (deps.instructions !== undefined && context.client.session.setInstructions !== undefined) {
    // Re-assert instructions on non-command turns so a reconnect or prompt
    // variant never drifts from the harness prompt (best-effort: native
    // commands expand provider-owned templates that take no system addendum).
    const instructions = deps.instructions;
    yield* runOpenCode2SdkWithTimeout("session.instructions", (signal) =>
      context.client.session.setInstructions!(
        { sessionID: context.openCodeSessionId, instructions },
        { signal },
      ),
    ).pipe(withSubmissionTimeout("session.instructions"), Effect.asVoid, Effect.ignore);
  }
  const submissionMethod = nativeCommand !== undefined ? "session.command" : "session.promptAsync";
  const submission =
    nativeCommand !== undefined
      ? runOpenCode2SdkWithTimeout(submissionMethod, (signal) =>
          context.client.session.command(
            {
              sessionID: context.openCodeSessionId,
              messageID: messageId,
              command: nativeCommand.name,
              arguments: commandMatch?.[2] ?? "",
              model: modelSlug,
              ...(effectiveAgent !== undefined ? { agent: effectiveAgent } : {}),
              ...(variant !== undefined ? { variant } : {}),
              parts: fileParts,
            },
            { signal },
          ),
        )
      : runOpenCode2SdkWithTimeout(submissionMethod, (signal) =>
          context.client.session.promptAsync(
            {
              sessionID: context.openCodeSessionId,
              messageID: messageId,
              model: parsedModel,
              ...(effectiveAgent !== undefined ? { agent: effectiveAgent } : {}),
              ...(variant !== undefined ? { variant } : {}),
              system: buildRuntimeInstructions({ harness: "OpenCode2", model: modelSlug }),
              parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
            },
            { signal },
          ),
        );
  yield* submission.pipe(withSubmissionTimeout(submissionMethod), Effect.asVoid);

  // Mark the turn running only after admission: a failed submission must not
  // leave a phantom active turn that blocks compaction and turns the next
  // interrupt into a stale abort.
  context.activeTurnId = turnId;
  context.activeAgent = effectiveAgent;
  context.activeVariant = variant;
  if (steeringTurnId === undefined) {
    resetOpenCode2TurnUsage(context);
  }
  context.session = {
    ...context.session,
    status: "running",
    activeTurnId: turnId,
    model: modelSelection?.model ?? context.session.model,
    updatedAt: yield* deps.nowIso,
  };
  if (steeringTurnId === undefined) {
    yield* emitTurnStarted(events, {
      threadId: input.threadId,
      turnId,
      model: modelSelection?.model ?? context.session.model,
      providerInstanceId: context.session.providerInstanceId,
      eventId: (yield* deps.randomEventId) as EventId,
      createdAt: yield* deps.nowIso,
    });
  }
  return {
    threadId: input.threadId,
    turnId,
    resumeCursor: context.session.resumeCursor,
  };
});

/**
 * Interrupt the active turn. A turn-id mismatch is a no-op; without an
 * active turn there is nothing to abort. Native `session.interrupt` keeps
 * the run resumable (`resume` omitted); the legacy structural `abort` (v2
 * has no abort endpoint — the binding emulates it as `interrupt` with
 * `resume: false`) is the fallback when the binding predates `interrupt`.
 */
export const interruptOpenCode2Turn = Effect.fn("interruptOpenCode2Turn")(function* (
  store: OpenCode2SessionStore,
  threadId: ThreadId,
  turnId?: TurnId | undefined,
): Effect.fn.Return<void, OpenCode2AdapterError> {
  const context = yield* ensureOpenCode2Context(store, threadId);
  const activeTurnId = context.activeTurnId;
  if (turnId !== undefined && activeTurnId !== turnId) {
    return;
  }
  const interruptedTurnId = turnId ?? activeTurnId;
  if (interruptedTurnId === undefined) {
    return;
  }
  if (context.client.session.interrupt !== undefined) {
    const outcome = yield* runOpenCode2SdkWithTimeout("session.interrupt", (signal) =>
      context.client.session.interrupt!({ sessionID: context.openCodeSessionId }, { signal }),
    ).pipe(
      withSubmissionTimeout("session.interrupt"),
      Effect.map((response) => response as { readonly interrupted?: boolean } | undefined | void),
      Effect.exit,
    );
    if (Exit.isSuccess(outcome) && outcome.value?.interrupted === false) {
      // The server reports nothing to interrupt (already settled). Clear the
      // local turn instead of forcing an abort that could cancel a newer run.
      if (context.activeTurnId === interruptedTurnId) {
        context.activeTurnId = undefined;
        context.session = { ...context.session, status: "ready" };
        delete (context.session as Record<string, unknown>).activeTurnId;
      }
      return;
    }
    if (Exit.isFailure(outcome)) {
      return yield* Effect.failCause(outcome.cause);
    }
  } else {
    yield* runOpenCode2SdkWithTimeout("session.abort", (signal) =>
      context.client.session.abort({ sessionID: context.openCodeSessionId }, { signal }),
    ).pipe(withSubmissionTimeout("session.abort"), Effect.asVoid);
    // The structural abort is emulated as `interrupt(resume: false)` on the
    // concrete binding, so it shares the native interrupt ack: the run stops
    // without resuming.
  }
  if (context.activeTurnId === interruptedTurnId) {
    context.activeTurnId = undefined;
    context.session = { ...context.session, status: "ready" };
    delete (context.session as Record<string, unknown>).activeTurnId;
  }
  yield* abortOpenCode2Descendants(context).pipe(
    Effect.timeout(`${OPENCODE2_TEARDOWN_TIMEOUT_MS} millis`),
    Effect.ignore,
  );
});

export interface OpenCode2TurnEventDeps {
  readonly events: Queue.Enqueue<ProviderRuntimeEvent>;
  readonly randomEventId: Effect.Effect<string>;
  readonly nowIso: Effect.Effect<string>;
}

/**
 * Fold one translator-normalized usage snapshot into the active turn's
 * accumulator. No-op when the thread has no context (stopped/unknown) or no
 * active turn — late usage frames after settlement must not resurrect usage.
 */
export const recordOpenCode2TurnUsage = Effect.fn("recordOpenCode2TurnUsage")(function* (
  store: OpenCode2SessionStore,
  threadId: ThreadId,
  usage: ThreadTokenUsageSnapshot,
  sessionId?: string | undefined,
): Effect.fn.Return<void, never> {
  const context = store.get(threadId);
  if (context === undefined || context.activeTurnId === undefined) {
    return;
  }
  if (yield* Ref.get(context.stopped)) {
    return;
  }
  accumulateOpenCode2TurnUsage(context, usage, sessionId);
});

const emitTurnSettled = (
  context: OpenCode2SessionContext,
  deps: OpenCode2TurnEventDeps,
  event: {
    readonly type: "turn.completed" | "turn.aborted";
    readonly turnId: TurnId;
    readonly payload: Record<string, unknown>;
    readonly raw?: unknown;
  },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Queue.offer(deps.events, {
      eventId: (yield* deps.randomEventId) as EventId,
      provider: "opencode2" as ProviderRuntimeEvent["provider"],
      ...(context.session.providerInstanceId !== undefined
        ? { providerInstanceId: context.session.providerInstanceId }
        : {}),
      threadId: context.session.threadId,
      createdAt: yield* deps.nowIso,
      turnId: event.turnId,
      type: event.type,
      payload: event.payload,
      ...(event.raw !== undefined
        ? { raw: { source: "opencode.sdk.event" as const, payload: event.raw } }
        : {}),
    } as unknown as ProviderRuntimeEvent).pipe(Effect.asVoid);
  });

const clearOpenCode2TurnState = (
  context: OpenCode2SessionContext,
  turnId: TurnId,
  updatedAt: string,
): void => {
  if (context.activeTurnId !== turnId) {
    return;
  }
  context.activeTurnId = undefined;
  context.activeAgent = undefined;
  context.activeVariant = undefined;
  context.session = { ...context.session, status: "ready", updatedAt };
  delete (context.session as Record<string, unknown>).activeTurnId;
};

/**
 * Settle the active turn as completed. Mirrors v1 `completeOpenCodeTurn`:
 * stale terminal frames (wrong turn, stopped context) are no-ops, pending
 * requests recover, and the drained usage rides the `turn.completed` payload.
 * `failed` carries the translator's `errorMessage`; anything else completes.
 */
export const completeOpenCode2Turn = Effect.fn("completeOpenCode2Turn")(function* (
  store: OpenCode2SessionStore,
  threadId: ThreadId,
  turnId: TurnId,
  outcome: { readonly state: "completed" | "failed"; readonly errorMessage?: string | undefined },
  deps: OpenCode2TurnEventDeps,
  raw?: unknown,
): Effect.fn.Return<void, never> {
  const context = store.get(threadId);
  if (context === undefined || context.activeTurnId !== turnId) {
    return;
  }
  if (yield* Ref.get(context.stopped)) {
    return;
  }
  const tokenUsage: TurnTokenUsage = takeOpenCode2TurnUsage(context);
  const updatedAt = yield* deps.nowIso;
  clearOpenCode2TurnState(context, turnId, updatedAt);
  yield* recoverOpenCode2PendingRequests(store, threadId, deps).pipe(Effect.ignore);
  yield* emitTurnSettled(context, deps, {
    type: "turn.completed",
    turnId,
    payload: {
      state: outcome.state,
      ...(outcome.state === "failed" && outcome.errorMessage !== undefined
        ? { errorMessage: outcome.errorMessage }
        : {}),
      tokenUsage,
    },
    ...(raw !== undefined ? { raw } : {}),
  });
});

/**
 * Settle the active turn as aborted. Mirrors v1 `interruptOpenCodeTurn`:
 * stale frames are no-ops, pending requests close, and descendants stop.
 */
export const abortOpenCode2Turn = Effect.fn("abortOpenCode2Turn")(function* (
  store: OpenCode2SessionStore,
  threadId: ThreadId,
  turnId: TurnId,
  reason: string,
  deps: OpenCode2TurnEventDeps,
  raw?: unknown,
): Effect.fn.Return<void, never> {
  const context = store.get(threadId);
  if (context === undefined || context.activeTurnId !== turnId) {
    return;
  }
  if (yield* Ref.get(context.stopped)) {
    return;
  }
  const tokenUsage: TurnTokenUsage = takeOpenCode2TurnUsage(context);
  const updatedAt = yield* deps.nowIso;
  clearOpenCode2TurnState(context, turnId, updatedAt);
  yield* abortOpenCode2Descendants(context).pipe(
    Effect.timeout(`${OPENCODE2_TEARDOWN_TIMEOUT_MS} millis`),
    Effect.ignore,
  );
  yield* recoverOpenCode2PendingRequests(store, threadId, deps).pipe(Effect.ignore);
  yield* emitTurnSettled(context, deps, {
    type: "turn.aborted",
    turnId,
    payload: { reason, tokenUsage },
    ...(raw !== undefined ? { raw } : {}),
  });
});

/**
 * Pending-request recovery after a turn settles: close locally-tracked
 * requests the server already marked terminal (the terminal frame raced the
 * settle path). Mirrors v1 `schedulePendingRequestRecovery`'s close-stale
 * half; the re-emit half lives in the pump handler (`handleOpenCode2TranslatedEvent`
 * in `OpenCode2SessionStore.ts` — unknown ids re-open on the next
 * `request.opened` frame). Resolution here is silent (no terminal emit).
 */
export const recoverOpenCode2PendingRequests = Effect.fn("recoverOpenCode2PendingRequests")(
  function* (
    store: OpenCode2SessionStore,
    threadId: ThreadId,
    _deps: OpenCode2TurnEventDeps,
  ): Effect.fn.Return<void, never> {
    const context = store.get(threadId);
    if (context === undefined) {
      return;
    }
    if (yield* Ref.get(context.stopped)) {
      return;
    }
    if (context.pendingPermissions.size === 0 && context.pendingQuestions.size === 0) {
      return;
    }
    // The structural client has no permission/form list slots (those live on
    // the concrete SDK binding), so recovery can only close what the pump
    // already resolved: drop ids the server marked terminal. This keeps
    // locally-resolved ids from lingering when the terminal frame raced the
    // settle path.
    for (const requestId of context.pendingPermissions.keys()) {
      if (context.emittedTerminalRequestIds.has(requestId)) {
        context.pendingPermissions.delete(requestId);
      }
    }
    for (const requestId of context.pendingQuestions.keys()) {
      if (context.emittedTerminalRequestIds.has(requestId)) {
        context.pendingQuestions.delete(requestId);
      }
    }
  },
);

export const nowIsoDefault: Effect.Effect<string> = DateTime.now.pipe(
  Effect.map(DateTime.formatIso),
);

export interface OpenCode2CompactDeps {
  readonly boundInstanceId: ProviderSession["providerInstanceId"];
}

const COMPACTION_TIMEOUT_MS = OPENCODE2_COMPACTION_TIMEOUT_MS;

const withCompactionTimeout = (
  effect: Effect.Effect<void, OpenCode2AdapterError>,
  method: "session.compact" | "session.wait",
): Effect.Effect<void, OpenCode2AdapterError> =>
  Effect.timeoutOrElse(effect, {
    duration: `${COMPACTION_TIMEOUT_MS} millis`,
    orElse: () =>
      Effect.fail(
        openCode2RequestError(
          method,
          "OpenCode 2 session compaction did not complete within 10 minutes.",
        ),
      ),
  });

/**
 * Compact a thread via the v2-native `session.compact` inbox run: validate
 * the model selection (switching in-session first, mirroring sendTurn), then
 * compact and wait for the session to settle. Compaction requires an active
 * `provider/model` selection and refuses while a turn is running (mirrors
 * the v1 `compactThread` budgets: 10s model-switch admission, 10min compact
 * + settle).
 */
export const compactOpenCode2Thread = Effect.fn("compactOpenCode2Thread")(function* (
  store: OpenCode2SessionStore,
  threadId: ThreadId,
  requestedModelSelection: ProviderSendTurnInput["modelSelection"],
  deps: OpenCode2CompactDeps,
): Effect.fn.Return<void, OpenCode2AdapterError> {
  const context = yield* ensureOpenCode2Context(store, threadId);
  const modelSelection =
    requestedModelSelection ??
    (context.session.model !== undefined && deps.boundInstanceId !== undefined
      ? { instanceId: deps.boundInstanceId, model: context.session.model }
      : undefined);
  if (
    modelSelection !== undefined &&
    deps.boundInstanceId !== undefined &&
    modelSelection.instanceId !== deps.boundInstanceId
  ) {
    return yield* openCode2ValidationError(
      "compactThread",
      `OpenCode 2 model selection is bound to instance '${modelSelection.instanceId}', expected '${deps.boundInstanceId}'.`,
    );
  }
  const parsedModel = parseOpenCode2ModelSlug(modelSelection?.model);
  if (!parsedModel) {
    return yield* openCode2ValidationError(
      "compactThread",
      "OpenCode 2 compaction requires an active 'provider/model' selection.",
    );
  }
  if (context.activeTurnId !== undefined) {
    return yield* openCode2ValidationError(
      "compactThread",
      "OpenCode 2 cannot compact while a turn is running.",
    );
  }
  const modelSlug = `${parsedModel.providerID}/${parsedModel.modelID}`;
  // Mirror sendTurn: selection-options variant wins, else the slug #variant.
  const compactVariant =
    getModelSelectionStringOptionValue(modelSelection, "variant") ?? parsedModel.variant;
  if (needsOpenCode2ModelSwitch(context, modelSlug, compactVariant)) {
    yield* runOpenCode2SdkWithTimeout("session.switchModel", (signal) =>
      context.client.session.switchModel(
        {
          sessionID: context.openCodeSessionId,
          model: modelSlug,
          ...(compactVariant !== undefined ? { variant: compactVariant } : {}),
        },
        { signal },
      ),
    ).pipe(withSubmissionTimeout("session.switchModel"), Effect.asVoid);
    recordOpenCode2ModelSwitch(context, modelSlug, compactVariant);
    context.session = {
      ...context.session,
      model: modelSelection?.model ?? context.session.model,
    };
  }
  const compact = context.client.session.compact;
  if (compact === undefined) {
    return yield* openCode2RequestError(
      "session.compact",
      "OpenCode 2 session.compact is not available on this client binding.",
    );
  }
  yield* runOpenCode2SdkWithTimeout("session.compact", (signal) =>
    compact({ sessionID: context.openCodeSessionId }, { signal }),
  ).pipe((effect) => withCompactionTimeout(Effect.asVoid(effect), "session.compact"));
  yield* runOpenCode2SdkWithTimeout("session.wait", (signal) =>
    context.client.session.wait({ sessionID: context.openCodeSessionId }, { signal }),
  ).pipe((effect) => withCompactionTimeout(Effect.asVoid(effect), "session.wait"));
});
