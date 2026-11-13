/**
 * The T3 session runtime surface for one OpenCode 2 provider session.
 */
import {
  AbsolutePath,
  Agent,
  Form,
  Location,
  Permission,
  Session,
  SessionMessage,
} from "@opencode/client/effect";
import { type OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { OPENCODE_PROVIDER } from "../../adapter.ts";
import {
  ACTIVE_CHECK_TIMEOUT,
  CLEAR_PROMPT_REJECTIONS,
  DECLINED,
  INTERRUPT_TIMEOUT,
  OPENCODE_2_STILL_STOPPING,
  RECONNECT_WAIT,
  REQUEST_REPLY_TIMEOUT,
  agentFor,
  approves,
  boundaryAfter,
  declinedNote,
  deliver,
  formAnswer,
  formGone,
  isContinuation,
  isProviderAdapterError,
  malformedModel,
  modelRef,
  permissionGone,
  ref,
  sameModel,
  sessionIdOf,
  steerPromptId,
} from "./protocol.ts";
import type { TurnStart } from "./turnStart.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { Routing } from "./routing.ts";
import type { Requests } from "./requests.ts";
import type { Turns } from "./turns.ts";
import type { Config } from "./config.ts";
import type { Projections } from "./projections.ts";
import type { ThreadHistory } from "./history.ts";
import type { State } from "./state.ts";

export const makeRuntime = (
  deps: State & Projections & Config & Turns & Requests & Routing & Lifecycle & TurnStart & ThreadHistory,
): ProviderAdapter.ProviderAdapterV2SessionRuntime => {
  const {
    abandonRequest,
    beginTurn,
    cancelStrandedSteers,
    childOwners,
    clearRevert,
    driver,
    endIfSettled,
    ensureQuiet,
    events,
    exclusive,
    finishTurn,
    forgetRequest,
    hasBackground,
    host,
    idAllocator,
    input,
    instanceId,
    live,
    lock,
    markUnsettled,
    owesWork,
    pending,
    prepareTurn,
    promptFiles,
    readModelsOnce,
    register,
    removeMcp,
    rollBackTo,
    rootOf,
    rulesFor,
    runWake,
    runningCalls,
    snapshotOf,
    stagedReverts,
    stopBackground,
    stopLeftoverRequests,
    submit,
    takeRunningWake,
    threads,
    userMessages,
    windowOf,
    writeRules,
    writeTitle,
    readThreadSnapshot,
    forkThread,
  } = deps;

  const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
    instanceId,
    driver,
    providerSessionId: input.providerSessionId,
    get providerSession() {
      return live.session;
    },
    events: Stream.fromQueue(events),
    // Idle release must wait for background children and held wakes after parent settlement.
    hasPendingBackgroundWork: Effect.sync(() => [...threads.values()].some(owesWork)),
    hasPendingBackgroundWorkForThread: (providerThread) =>
      Effect.sync(() => {
        const nativeId = providerThread.nativeThreadRef?.nativeId;
        const state = nativeId == null ? undefined : threads.get(nativeId);
        return state !== undefined && hasBackground(state);
      }),
    getModelContextWindow: (selection, cwd) =>
      selection.instanceId === instanceId
        ? windowOf(cwd === undefined ? live.session.cwd : cwd, selection.model)
        : undefined,
    ensureThread: Effect.fn("OpenCode2Adapter.ensureThread")(
      function* (threadInput) {
        if (threadInput.existingProviderThread?.nativeThreadRef != null) {
          return yield* runtime.resumeThread({
            providerThread: threadInput.existingProviderThread,
            threadId: threadInput.threadId,
            modelSelection: threadInput.modelSelection,
            runtimePolicy: threadInput.runtimePolicy,
          });
        }
        yield* readModelsOnce(threadInput.runtimePolicy.cwd);
        const model = modelRef(threadInput.modelSelection);
        if (model === undefined) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: OPENCODE_PROVIDER,
            detail: malformedModel(threadInput.modelSelection.model),
          });
        }
        const directory = threadInput.runtimePolicy.cwd ?? host.paths.cwd;
        const policy = threadInput.runtimePolicy;
        const permissions = yield* rulesFor(
          { directory, agent: "build", grants: [] },
          policy,
          threadInput.threadId,
        );
        const title = threadInput.title?.trim() || undefined;
        // A session created with a title is never titled by OpenCode's own model.
        const created = yield* live.client.session.create({
          location: Location.PublicRef.make({ directory: AbsolutePath.make(directory) }),
          model,
          permissions,
          ...(title === undefined ? {} : { title }),
        });
        const createdAt = yield* DateTime.now;
        const providerThread: OrchestrationV2ProviderThread = {
          ...(threadInput.existingProviderThread ?? {
            id: idAllocator.derive.providerThread({ driver, nativeThreadId: created.id }),
            driver,
            providerInstanceId: instanceId,
            appThreadId: threadInput.threadId,
            ownerNodeId: null,
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt,
          }),
          providerSessionId: input.providerSessionId,
          nativeThreadRef: ref(created.id),
          nativeConversationHeadRef: null,
          status: "idle",
          updatedAt: createdAt,
        };
        const state = register(
          providerThread,
          {
            id: created.id,
            model: created.model,
            agent: created.agent,
            title: title ?? created.title,
            permissions,
          },
          directory,
        );
        state.policy = policy;
        return state.providerThread;
      },
      (effect, threadInput) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isProviderAdapterError(cause)
              ? cause
              : new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver,
                  threadId: threadInput.threadId,
                  cause,
                }),
          ),
        ),
    ),
    resumeThread: Effect.fn("OpenCode2Adapter.resumeThread")(
      function* (threadInput) {
        const sessionId = yield* sessionIdOf(threadInput.providerThread);
        if (threadInput.runtimePolicy !== undefined) {
          yield* readModelsOnce(threadInput.runtimePolicy.cwd);
        }
        const native = yield* live.client.session.get({ sessionID: Session.ID.make(sessionId) });
        const providerThread: OrchestrationV2ProviderThread = {
          ...threadInput.providerThread,
          providerSessionId: input.providerSessionId,
          status: "idle",
          updatedAt: yield* DateTime.now,
        };
        const cwd = threadInput.runtimePolicy?.cwd;
        const loaded = threads.has(sessionId);
        const state = register(providerThread, native, cwd ?? native.location.directory);
        if (!loaded) yield* stopLeftoverRequests(state);
        yield* writeRules(state, threadInput.runtimePolicy ?? state.policy);
        if (cwd != null && native.location.directory !== cwd) {
          yield* live.client.session.move({
            sessionID: Session.ID.make(sessionId),
            directory: AbsolutePath.make(cwd),
          });
        }
        return state.providerThread;
      },
      (effect, threadInput) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isProviderAdapterError(cause)
              ? cause
              : new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
          ),
        ),
    ),
    compactThread: (turnInput) =>
      runtime.startTurn({ ...turnInput, message: { ...turnInput.message, text: "/compact" } }),
    startTurn: Effect.fn("OpenCode2Adapter.startTurn")(
      function* (turnInput) {
        // Waited out before the session's gate, so a rollback or fork is not
        // held behind a reconnect.
        if (live.streamFailure !== undefined) {
          yield* Deferred.await(live.reconnected).pipe(Effect.timeout(RECONNECT_WAIT), Effect.ignore);
        }
        if (live.streamFailure !== undefined) {
          return yield* new ProviderAdapter.ProviderAdapterEventStreamError({
            driver,
            providerSessionId: input.providerSessionId,
            cause: live.streamFailure,
          });
        }
        // Gate checks/setup so rollback/fork sees either no turn or the installed turn; prompt outside it.
        const started = yield* exclusive(turnInput.providerThread)(
          Effect.gen(function* () {
            const sessionId = yield* sessionIdOf(turnInput.providerThread);
            const state = threads.get(sessionId);
            if (state === undefined) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: OPENCODE_PROVIDER,
                detail: `OpenCode session ${sessionId} is not registered`,
              });
            }
            if (state.active !== undefined) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: OPENCODE_PROVIDER,
                detail: `OpenCode session ${sessionId} already has an active turn`,
                reason: "previous_turn_active",
              });
            }
            if (isContinuation(turnInput)) return yield* runWake(state, turnInput);
            const afterUnsettled = state.unsettled;
            let stillStopping = false;
            if (state.unsettled) {
              const active = yield* live.client.session
                .active()
                .pipe(Effect.timeout(ACTIVE_CHECK_TIMEOUT));
              stillStopping = sessionId in active;
              if (stillStopping) {
                yield* live.client.session
                  .interrupt({ sessionID: Session.ID.make(sessionId) })
                  .pipe(Effect.timeout(INTERRUPT_TIMEOUT), Effect.ignore({ log: true }));
              } else {
                state.unsettled = false;
              }
            }
            const begin = beginTurn(state, turnInput, afterUnsettled);
            if (stillStopping) {
              yield* begin;
              return yield* finishTurn(state, {
                status: "failed",
                failure: makeProviderFailure({
                  message: OPENCODE_2_STILL_STOPPING,
                  class: "provider_error",
                }),
              });
            }
            const model = modelRef(turnInput.modelSelection);
            if (model === undefined) {
              yield* begin;
              return yield* finishTurn(state, {
                status: "failed",
                failure: makeProviderFailure({
                  message: malformedModel(turnInput.modelSelection.model),
                  class: "validation_error",
                }),
              });
            }
            // Switch to the plan agent before writing rules to retain its own path allows.
            const agent = agentFor(turnInput);
            if (agent !== state.agent) {
              yield* live.client.session.switchAgent({
                sessionID: Session.ID.make(sessionId),
                agent: Agent.ID.make(agent),
              });
              state.agent = agent;
            }
            // Refresh stale mode rules; running subagent updates are best effort because they outlive this turn.
            yield* writeRules(state, turnInput.runtimePolicy);
            yield* writeTitle(state, turnInput.appThread.title).pipe(
              Effect.timeout(REQUEST_REPLY_TIMEOUT),
              Effect.ignore({ log: true }),
            );
            for (const call of runningCalls(state)) {
              if (call.child === undefined) continue;
              yield* writeRules(call.child, turnInput.runtimePolicy).pipe(
                Effect.timeout(REQUEST_REPLY_TIMEOUT),
                Effect.ignore({ log: true }),
              );
            }
            if (!sameModel(model, state.model)) {
              yield* live.client.session.switchModel({ sessionID: Session.ID.make(sessionId), model });
              state.model = model;
            }
            // Old undelivered steers would run first; failed rollback stages would commit on this prompt.
            yield* cancelStrandedSteers(state);
            if (stagedReverts.has(sessionId)) yield* clearRevert(sessionId);
            yield* prepareTurn(sessionId, state, turnInput);
            const turn = yield* begin;
            turn.unsent = true;
            yield* lock.withPermit(takeRunningWake(state));
            return { state, sessionId, turn };
          }),
        );
        if (started === undefined) return;
        const { state, sessionId, turn } = started;
        yield* submit(sessionId, turnInput, state, turn).pipe(
          // Forget externally deleted sessions so the next turn recreates them with handoff.
          Effect.catchTags({
            SessionNotFoundError: () =>
              finishTurn(
                state,
                {
                  status: "failed",
                  failure: makeProviderFailure({
                    message:
                      "The OpenCode session no longer exists. Send the message again to continue in a new session.",
                    class: "provider_error",
                  }),
                },
                "broken",
              ).pipe(Effect.andThen(Effect.sync(() => threads.delete(sessionId)))),
          }),
          Effect.tapError((cause) =>
            state.active === turn
              ? Effect.gen(function* () {
                  if (!CLEAR_PROMPT_REJECTIONS.has(cause._tag)) markUnsettled(state);
                  yield* finishTurn(state, {
                    status: "failed",
                    failure: makeProviderFailure({ cause, class: "provider_error" }),
                  });
                })
              : Effect.void,
          ),
        );
      },
      (effect, turnInput) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isProviderAdapterError(cause)
              ? cause
              : new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause,
                }),
          ),
        ),
    ),
    steerTurn: Effect.fn("OpenCode2Adapter.steerTurn")(
      function* (steerInput) {
        const sessionId = yield* sessionIdOf(steerInput.providerThread);
        const state = threads.get(sessionId);
        const turn = state?.active;
        if (
          state === undefined ||
          turn === undefined ||
          turn.providerTurn.id !== steerInput.providerTurnId ||
          turn.interrupted
        ) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: OPENCODE_PROVIDER,
            detail: `OpenCode turn ${steerInput.providerTurnId} is not active`,
          });
        }
        const inboxID = steerPromptId(sessionId, steerInput.message.messageId);
        if (turn.settledInbox.has(inboxID)) return;
        turn.steers.add(inboxID);
        state.strandedSteers.delete(inboxID);
        const { files, messageText } = yield* Effect.gen(function* () {
          const files = yield* promptFiles(steerInput.message.attachments);
          const messageText = (yield* providerMessageTextWithAttachmentPaths({
            text: steerInput.message.text,
            attachments: steerInput.message.attachments,
            resolveAttachmentPath: host.resolveAttachmentPath,
            resolveExtractedTextPath: host.resolveExtractedTextPath,
          })).trim();
          return { files, messageText };
        }).pipe(
          Effect.onInterrupt(() =>
            lock.withPermit(
              Effect.gen(function* () {
                turn.steers.delete(inboxID);
                state.strandedSteers.delete(inboxID);
                if (state.active === turn) yield* endIfSettled(state, turn);
              }),
            ),
          ),
        );
        if (state.active !== turn || turn.interrupted) {
          yield* lock.withPermit(
            Effect.gen(function* () {
              turn.steers.delete(inboxID);
              // Stop may have stranded this steer, but it never reached OpenCode.
              state.strandedSteers.delete(inboxID);
              if (state.active === turn) {
                if (turn.interrupted && turn.heldEnd !== undefined) {
                  turn.heldEnd = { status: "interrupted" };
                }
                yield* endIfSettled(state, turn);
              }
            }),
          );
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: OPENCODE_PROVIDER,
            detail: `OpenCode turn ${steerInput.providerTurnId} is not active`,
          });
        }
        yield* live.client.session
          .prompt({
            sessionID: Session.ID.make(sessionId),
            id: inboxID,
            text: messageText,
            ...(files.length === 0 ? {} : { files }),
            delivery: "steer",
          })
          .pipe(
            Effect.tapError((cause) =>
              lock.withPermit(
                Effect.gen(function* () {
                  turn.steers.delete(inboxID);
                  if (!CLEAR_PROMPT_REJECTIONS.has(cause._tag)) state.strandedSteers.add(inboxID);
                  if (state.active === turn) yield* endIfSettled(state, turn);
                }),
              ),
            ),
          );
      },
      (effect, steerInput) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isProviderAdapterError(cause)
              ? cause
              : new ProviderAdapter.ProviderAdapterSteerRunError({
                  driver,
                  providerThreadId: steerInput.providerThread.id,
                  providerTurnId: steerInput.providerTurnId,
                  cause,
                }),
          ),
        ),
    ),
    interruptTurn: Effect.fn("OpenCode2Adapter.interruptTurn")(
      function* (interruptInput) {
        const sessionId = yield* sessionIdOf(interruptInput.providerThread);
        const state = threads.get(sessionId);
        if (state === undefined) return;
        const turn = state.active;
        // User Stop must end background children and their report execution; steering leaves them running.
        if (interruptInput.requestRuntimeRestart === true) yield* stopBackground(state);
        if (turn === undefined || turn.providerTurn.id !== interruptInput.providerTurnId) {
          return;
        }
        turn.interrupted = true;
        const reply = yield* live.client.session
          .interrupt({ sessionID: Session.ID.make(sessionId) })
          .pipe(
            Effect.timeoutOption(INTERRUPT_TIMEOUT),
            Effect.tapError(() =>
              Effect.sync(() => {
                turn.interrupted = false;
              }),
            ),
          );
        if (reply._tag === "None") {
          markUnsettled(state);
          return yield* lock.withPermit(finishTurn(state, { status: "interrupted" }));
        }
        // Stop between steer executions retracts pending steers and skips any run they already started.
        if (!reply.value.interrupted && state.active === turn && turn.heldEnd !== undefined) {
          markUnsettled(state);
          yield* lock.withPermit(finishTurn(state, { status: "interrupted" }));
          return yield* cancelStrandedSteers(state);
        }
        if (!reply.value.interrupted && state.active === turn && turn.unsent) {
          return yield* lock.withPermit(finishTurn(state, { status: "interrupted" }));
        }
        if (!reply.value.interrupted && state.active === turn) {
          turn.interrupted = false;
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: OPENCODE_PROVIDER,
            detail: `OpenCode session ${sessionId} had nothing running to stop`,
          });
        }
      },
      (effect, interruptInput) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isProviderAdapterError(cause)
              ? cause
              : new ProviderAdapter.ProviderAdapterInterruptError({
                  driver,
                  providerThreadId: interruptInput.providerThread.id,
                  providerTurnId: interruptInput.providerTurnId,
                  cause,
                }),
          ),
        ),
    ),
    unloadThread: Effect.fn("OpenCode2Adapter.unloadThread")(function* ({ providerThread }) {
      const nativeId = providerThread.nativeThreadRef?.nativeId;
      const state = nativeId == null ? undefined : threads.get(nativeId);
      if (
        nativeId == null ||
        state === undefined ||
        state.active !== undefined ||
        hasBackground(state)
      ) {
        return;
      }
      threads.delete(nativeId);
      for (const [child, owner] of childOwners) {
        if (owner !== state) continue;
        childOwners.delete(child);
        threads.delete(child);
      }
      if (state.mcp !== undefined) yield* removeMcp(state.mcp);
    }),
    respondToRuntimeRequest: Effect.fn("OpenCode2Adapter.respondToRuntimeRequest")(
      function* (requestInput) {
        const entry = pending.get(requestInput.requestId);
        if (entry === undefined || entry.answering) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver,
            detail: `No pending OpenCode request ${requestInput.requestId}`,
          });
        }
        const { decision, answers } = requestInput;
        const { native } = entry;
        if (native.type === "permission" && decision === undefined) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver,
            detail: `OpenCode approval request ${requestInput.requestId} requires a decision`,
          });
        }
        entry.answering = true;
        // Native always grants persist in the asking subagent's project, not its parent's.
        const asker = threads.get(entry.sessionId) ?? entry.state;
        if (
          native.type === "permission" &&
          (decision === "acceptForSession" || decision === "acceptAlways")
        ) {
          const state = asker;
          for (const resource of native.save) {
            if (
              !state.grants.some(
                (grant) => grant.action === native.action && grant.resource === resource,
              )
            ) {
              state.grants.push({ action: native.action, resource, effect: "allow" });
            }
          }
          yield* writeRules(state, rootOf(state).policy).pipe(Effect.ignore({ log: true }));
        }
        const sessionID = Session.ID.make(entry.sessionId);
        if (native.type === "permission" && decision === "decline") {
          yield* live.client.session
            .synthetic({
              sessionID,
              text: declinedNote(native.action, native.resources),
              delivery: "steer",
              resume: false,
            })
            .pipe(Effect.timeout(REQUEST_REPLY_TIMEOUT), Effect.ignore({ log: true }));
        }
        const delivered = yield* native.type === "permission"
          ? deliver(
              live.client.permission
                .reply({
                  sessionID,
                  requestID: Permission.ID.make(native.id),
                  decision: decision !== undefined && approves(decision) ? "once" : "reject",
                  ...(decision === "decline" ? { message: DECLINED } : {}),
                })
                .pipe(Effect.catchTags(permissionGone)),
            )
          : deliver(
              (answers === undefined || decision === "decline" || decision === "cancel"
                ? live.client.session.form.cancel({
                    sessionID: entry.sessionId,
                    formID: Form.ID.make(native.id),
                  })
                : live.client.session.form.reply({
                    sessionID: entry.sessionId,
                    formID: Form.ID.make(native.id),
                    answer: formAnswer(native.form, answers),
                  })
              ).pipe(Effect.catchTags(formGone)),
            );
        yield* forgetRequest(entry);
        if (!delivered) yield* abandonRequest(asker, "answer not delivered");
      },
      (effect, requestInput) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isProviderAdapterError(cause)
              ? cause
              : new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                  driver,
                  requestId: requestInput.requestId,
                  cause,
                }),
          ),
        ),
    ),
    rollbackThread: Effect.fn("OpenCode2Adapter.rollbackThread")(
      function* (rollbackInput) {
        const { providerThread, target } = rollbackInput;
        const sessionId = yield* sessionIdOf(providerThread);
        yield* ensureQuiet(sessionId, "roll back");
        if (!threads.has(sessionId)) {
          yield* runtime.resumeThread({ providerThread });
          yield* ensureQuiet(sessionId, "roll back");
        }
        const boundary = yield* boundaryAfter(
          rollbackInput.providerThreadTurns,
          providerThread.id,
          target.type === "provider_turn" ? target.providerTurn : undefined,
          yield* userMessages(sessionId),
        );
        if (boundary !== null) {
          yield* rollBackTo(sessionId, SessionMessage.ID.make(boundary));
        }
        const keptOrdinal = target.type === "provider_turn" ? target.providerTurn.ordinal : 0;
        const loaded = threads.get(sessionId);
        for (const [id, turn] of loaded?.providerTurns ?? []) {
          if (turn.ordinal > keptOrdinal) loaded?.providerTurns.delete(id);
        }
        const snapshot = yield* snapshotOf(providerThread, sessionId);
        const kept = new Map(
          rollbackInput.providerThreadTurns
            .filter(
              (turn) =>
                turn.providerThreadId === providerThread.id && turn.ordinal <= keptOrdinal,
            )
            .map((turn) => [turn.id, turn] as const),
        );
        for (const turn of snapshot.providerTurns) kept.set(turn.id, turn);
        return { ...snapshot, providerTurns: [...kept.values()] };
      },
      (effect, rollbackInput) =>
        effect.pipe(
          exclusive(rollbackInput.providerThread),
          Effect.mapError((cause) =>
            isProviderAdapterError(cause)
              ? cause
              : new ProviderAdapter.ProviderAdapterRollbackThreadError({
                  driver,
                  providerThreadId: rollbackInput.providerThread.id,
                  checkpointId: rollbackInput.target.checkpointId,
                  cause,
                }),
          ),
        ),
    ),
    readThreadSnapshot,
    forkThread,
  };

  return runtime;
};

export type Runtime = ReturnType<typeof makeRuntime>;
