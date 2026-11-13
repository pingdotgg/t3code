/**
 * Prepares, submits and stops OpenCode 2 turns, wake continuations and background work.
 */
import * as NodeURL from "node:url";
import {
  Session,
  SessionMessage,
  Skill,
} from "@opencode/client/effect";
import {
  isOrchestrationV2WorkActive,
  type ChatAttachment,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as OpenCode2Client from "../OpenCode2Client.ts";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { OPENCODE_PROVIDER } from "../../adapter.ts";
import {
  ACTIVE_CHECK_TIMEOUT,
  INTERRUPT_TIMEOUT,
  INVENTORY_TIMEOUT,
  REQUEST_REPLY_TIMEOUT,
  commandOf,
  isContinuation,
  ref,
  skillMentions,
  text,
  textOf,
  turnPromptId,
  wakeTurnId,
} from "./protocol.ts";
import type { ActiveTurn, ModelRef, Rule, SubagentCall, ThreadState } from "./types.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { Routing } from "./routing.ts";
import type { Requests } from "./requests.ts";
import type { Turns } from "./turns.ts";
import type { Config } from "./config.ts";
import type { Projections } from "./projections.ts";
import type { State } from "./state.ts";

export const makeTurnStart = (
  deps: State & Projections & Config & Turns & Requests & Routing & Lifecycle,
) => {
  const {
    announced,
    busy,
    clearing,
    discardWakes,
    driver,
    emitProviderThread,
    emitProviderTurn,
    fileSystem,
    finishTurn,
    hasBackground,
    host,
    idAllocator,
    input,
    live,
    lock,
    makeTurn,
    markUnsettled,
    newThreadState,
    replay,
    runningCalls,
    sessionScope,
    sessionsOf,
    setSessionStatus,
    settleCall,
    skillsMentioned,
    stagedReverts,
    stopStrays,
    syncRoster,
    syncRosterAncestors,
    threads,
    withReportedModel,
  } = deps;

  const register = (
    providerThread: OrchestrationV2ProviderThread,
    native: {
      readonly id: string;
      readonly model?: ModelRef | undefined;
      readonly agent?: string | undefined;
      readonly title?: string | undefined;
      readonly permissions?: ReadonlyArray<Rule> | undefined;
    },
    directory: string,
  ) => {
    providerThread = withReportedModel(providerThread, native.model);
    const existing = threads.get(native.id);
    if (existing !== undefined) {
      existing.providerThread = providerThread;
      existing.model = native.model;
      existing.directory = directory;
      existing.agent = native.agent ?? existing.agent;
      existing.title = native.title;
      existing.rules = native.permissions;
      return existing;
    }
    const state = newThreadState(native.id, providerThread, directory, undefined);
    state.model = native.model;
    state.agent = native.agent ?? state.agent;
    state.title = native.title;
    state.rules = native.permissions;
    threads.set(native.id, state);
    return state;
  };

  // Background reports can wake sessions into history being cut; rollback must wait for them too.
  const ensureQuiet = Effect.fnUntraced(function* (
    sessionId: string,
    verb: "roll back" | "fork",
  ) {
    const state = threads.get(sessionId);
    const busyHere =
      state !== undefined &&
      (state.active !== undefined ||
        busy.has(sessionId) ||
        (verb === "roll back" && hasBackground(state)));
    const busyThere =
      !busyHere &&
      (state === undefined || state.unsettled) &&
      sessionId in (yield* live.client.session.active().pipe(Effect.timeout(ACTIVE_CHECK_TIMEOUT)));
    if (busyHere || busyThere) {
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver: OPENCODE_PROVIDER,
        detail: `Cannot ${verb} OpenCode session ${sessionId} while it is still working`,
      });
    }
  });

  const cancelStrandedSteers = Effect.fnUntraced(function* (state: ThreadState) {
    const sessionID = Session.ID.make(state.sessionId);
    for (const inboxID of Array.from(state.strandedSteers)) {
      const cancelled = yield* live.client.session.inbox
        .cancel({ sessionID, inboxID: SessionMessage.ID.make(inboxID) })
        .pipe(
          Effect.timeout(REQUEST_REPLY_TIMEOUT),
          Effect.tapCause((cause) =>
            Effect.logWarning("Could not take back an OpenCode steer.", cause),
          ),
          Effect.exit,
          Effect.map(Exit.isSuccess),
        );
      if (cancelled) state.strandedSteers.delete(inboxID);
    }
  });

  // OpenCode 2.0.18 executes even unstaged revert clears; wait so that end cannot settle a T3 turn.
  const clearRevert = Effect.fnUntraced(function* (sessionId: string) {
    const settled = yield* Deferred.make<void>();
    clearing.set(sessionId, settled);
    yield* live.client.session.revert
      .clear({ sessionID: Session.ID.make(sessionId) })
      .pipe(
        Effect.andThen(Deferred.await(settled)),
        Effect.timeout(REQUEST_REPLY_TIMEOUT),
        Effect.ensuring(Effect.sync(() => clearing.delete(sessionId))),
      );
    stagedReverts.delete(sessionId);
  });

  // Failed/interrupted rollbacks must clear staged reverts before the next prompt commits them.
  // Leave files to T3 checkpoints; history-only rewinds must preserve them.
  const rollBackTo = Effect.fnUntraced(function* (
    sessionId: string,
    boundary: SessionMessage.ID,
  ) {
    const sessionID = Session.ID.make(sessionId);
    // Bound each step so unresponsive servers cannot hold the gate and block the next turn.
    yield* live.client.session.revert.stage({ sessionID, messageID: boundary, files: false }).pipe(
      Effect.timeout(REQUEST_REPLY_TIMEOUT),
      Effect.andThen(
        live.client.session.revert.commit({ sessionID }).pipe(Effect.timeout(REQUEST_REPLY_TIMEOUT)),
      ),
      Effect.onError(() =>
        clearRevert(sessionId).pipe(
          Effect.tapError(() => Effect.sync(() => stagedReverts.add(sessionId))),
          Effect.ignore({ log: true }),
        ),
      ),
    );
  });

  // Rollback must validate full history before native mutation; forks only need prompts.
  const userMessages = (sessionId: string, types?: ReadonlyArray<"user" | "synthetic">) =>
    Stream.fromIterable(types ?? [undefined]).pipe(
      Stream.flatMap((type) =>
        OpenCode2Client.paginate(
          {
            sessionID: Session.ID.make(sessionId),
            limit: 100,
            ...(type === undefined ? {} : { type }),
          },
          live.client.message.list,
        ),
      ),
      Stream.runCollect,
      Effect.map(
        (messages) =>
          new Set(
            messages.flatMap((message) =>
              message.type === "user" || message.type === "synthetic" ? [String(message.id)] : [],
            ),
          ),
      ),
    );

  const snapshotOf = Effect.fnUntraced(function* (
    providerThread: OrchestrationV2ProviderThread,
    sessionId: string,
  ) {
    const history = yield* OpenCode2Client.paginate(
      { sessionID: Session.ID.make(sessionId), order: "asc" as const, limit: 100 },
      live.client.message.list,
    ).pipe(Stream.runCollect);
    const snapshotAt = yield* DateTime.now;
    const messages = history.flatMap((message): Array<OrchestrationV2ConversationMessage> => {
      const text =
        message.type === "user"
          ? message.text
          : message.type === "assistant"
            ? textOf(message.content)
            : "";
      if (text.length === 0 || (message.type !== "user" && message.type !== "assistant")) {
        return [];
      }
      const createdAt = message.time.created;
      return [
        {
          createdBy: message.type === "user" ? "user" : "agent",
          creationSource: "provider",
          id: idAllocator.derive.messageFromProviderItem({
            driver,
            nativeItemId: message.id,
          }),
          threadId: providerThread.appThreadId ?? input.threadId,
          runId: null,
          nodeId: null,
          role: message.type,
          text,
          attachments: [],
          streaming: false,
          createdAt,
          updatedAt: createdAt,
        },
      ];
    });
    const lastUser = history.findLast((message) => message.type === "user")?.id;
    const state = threads.get(sessionId);
    return {
      providerThread: {
        ...providerThread,
        providerSessionId: input.providerSessionId,
        nativeConversationHeadRef: lastUser === undefined ? null : ref(lastUser, "weak"),
        status: "idle" as const,
        updatedAt: snapshotAt,
      },
      providerTurns: state === undefined ? [] : [...state.providerTurns.values()],
      messages,
      runtimeRequests: [],
    };
  });

  const promptText = Effect.fnUntraced(function* (
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) {
    return (yield* providerMessageTextWithAttachmentPaths({
      text: turnInput.message.text,
      attachments: turnInput.message.attachments,
      resolveAttachmentPath: host.resolveAttachmentPath,
      resolveExtractedTextPath: host.resolveExtractedTextPath,
    })).trim();
  });

  const promptFiles = Effect.fnUntraced(function* (attachments: ReadonlyArray<ChatAttachment>) {
    const files: Array<{ uri: string; name: string }> = [];
    // An external server may not share T3's attachment directory.
    if (live.connection.external) return files;
    for (const attachment of attachments) {
      if (!isProviderNativeImageAttachment(attachment)) continue;
      const path = host.resolveAttachmentPath(attachment);
      if (path === null) continue;
      // OpenCode rejects the whole prompt if an attached file is missing.
      const exists = yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
      if (exists) files.push({ uri: NodeURL.pathToFileURL(path).href, name: attachment.name });
    }
    return files;
  });

  const markBefore = (sessionId: string, before: string | null) =>
    Effect.sync(() => {
      const turn = threads.get(sessionId)?.active;
      if (turn !== undefined) turn.before = before;
    });

  const beginTurn = Effect.fn("OpenCode2Adapter.beginTurn")(function* (
    state: ThreadState,
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
    awaitingStart: boolean,
  ) {
    const startedAt = yield* DateTime.now;
    const nativeTurnId = `${state.sessionId}:attempt:${turnInput.attemptId}`;
    const providerTurn: OrchestrationV2ProviderTurn = {
      id: idAllocator.derive.providerTurn({ driver, nativeTurnId }),
      providerThreadId: turnInput.providerThread.id,
      nodeId: turnInput.rootNodeId,
      runAttemptId: turnInput.attemptId,
      nativeTurnRef: ref(
        isContinuation(turnInput)
          ? wakeTurnId(state.sessionId, turnInput.attemptId)
          : turnPromptId(state.sessionId, turnInput.attemptId),
        "weak",
      ),
      ordinal: turnInput.providerTurnOrdinal,
      status: "running",
      startedAt,
      completedAt: null,
    };
    const turn = makeTurn(turnInput, providerTurn, { scope: "", awaitingStart });
    if (live.streamFailure !== undefined) {
      return yield* new ProviderAdapter.ProviderAdapterEventStreamError({
        driver,
        providerSessionId: input.providerSessionId,
        cause: live.streamFailure,
      });
    }
    state.active = turn;
    yield* emitProviderTurn(state, turn, providerTurn);
    state.providerThread = {
      ...state.providerThread,
      status: "active",
      firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
      lastRunOrdinal: turnInput.runOrdinal,
      updatedAt: startedAt,
    };
    yield* emitProviderThread(state);
    yield* setSessionStatus("running", null);
    return turn;
  });

  const takeRunningWake = Effect.fnUntraced(function* (state: ThreadState) {
    const wake = state.wakes.at(-1);
    if (wake?.running !== true) return;
    state.wakes.pop();
    yield* replay(wake);
    for (const each of sessionsOf(state).toReversed()) yield* syncRoster(each);
    yield* syncRosterAncestors(state);
  });

  const runWake = Effect.fnUntraced(function* (
    state: ThreadState,
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) {
    yield* beginTurn(state, turnInput, false);
    yield* lock.withPermit(
      Effect.gen(function* () {
        const index = state.wakes.findIndex(
          (held) => held.messageId === turnInput.message.messageId,
        );
        if (index < 0) return yield* finishTurn(state, { status: "completed" });
        // Continuations cannot reorder; earlier wakes stranded by cancel or failed dispatch would pin the session.
        discardWakes(state, state.wakes.splice(0, index));
        yield* Effect.forkIn(stopStrays(state), sessionScope);
        const wake = state.wakes.shift()!;
        const turn = state.active;
        if (turn !== undefined && wake.after !== undefined) turn.before = wake.after;
        // Its first report is where its history begins, so fork and rollback cut there.
        if (turn !== undefined && wake.first !== undefined) {
          turn.providerTurn = { ...turn.providerTurn, nativeTurnRef: ref(wake.first, "weak") };
        }
        if (wake.running) state.unsettled = false;
        yield* replay(wake);
        for (const each of sessionsOf(state).toReversed()) yield* syncRoster(each);
        yield* syncRosterAncestors(state);
      }),
    );
  });

  const stopBackground = Effect.fnUntraced(function* (state: ThreadState) {
    const calls = runningCalls(state).filter((call) => call.background);
    const callers = sessionsOf(state);
    // Ended subagent calls can run again to answer their own background reports.
    const followUps = callers.filter(
      (caller) =>
        caller.subagent !== undefined &&
        busy.has(caller.sessionId) &&
        !isOrchestrationV2WorkActive(caller.subagent.call.status),
    );
    // Child sessions are announced before call progress names them; use announcements to stop unnamed children.
    const announcedTo = (caller: ThreadState) =>
      [...announced.values()].flatMap((info) =>
        info.parentID === caller.sessionId ? [info.sessionID] : [],
      );
    const childrenOf = (call: SubagentCall) =>
      call.child === undefined ? announcedTo(call.state) : [call.child.sessionId];
    const children = new Map(
      calls.flatMap((call) => childrenOf(call).map((childId) => [childId, call.state] as const)),
    );
    const unreached = new Set<string>();
    for (const [childId, caller] of children) {
      caller.stoppedChildren.add(childId);
      const reached = yield* live.client.session
        .interrupt({ sessionID: Session.ID.make(childId) })
        .pipe(
          Effect.catchTags({ SessionNotFoundError: () => Effect.void }),
          Effect.timeout(INTERRUPT_TIMEOUT),
          Effect.tapCause((cause) =>
            Effect.logWarning("Could not stop an OpenCode subagent.", cause),
          ),
          Effect.exit,
          Effect.map(Exit.isSuccess),
        );
      if (!reached) unreached.add(childId);
    }
    for (const followUp of followUps) {
      yield* live.client.session
        .interrupt({ sessionID: Session.ID.make(followUp.sessionId) })
        .pipe(
          Effect.catchTags({ SessionNotFoundError: () => Effect.void }),
          Effect.timeout(INTERRUPT_TIMEOUT),
          Effect.ignore({ log: true }),
        );
    }
    yield* lock.withPermit(
      Effect.gen(function* () {
        for (const call of calls) {
          if (childrenOf(call).some((childId) => unreached.has(childId))) continue;
          yield* settleCall(call, "interrupted");
        }
        for (const caller of callers) {
          for (const report of caller.reports.values()) {
            caller.stoppedChildren.add(report.childId);
          }
        }
        const running = state.wakes.some((wake) => wake.running);
        discardWakes(state, state.wakes.splice(0));
        yield* syncRosterAncestors(state);
        if (running) {
          markUnsettled(state);
          yield* live.client.session
            .interrupt({ sessionID: Session.ID.make(state.sessionId) })
            .pipe(Effect.timeout(INTERRUPT_TIMEOUT), Effect.ignore({ log: true }));
        }
      }),
    );
    yield* stopStrays(state);
  });

  const submit = Effect.fnUntraced(function* (
    sessionId: string,
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
    state: ThreadState,
    turn: ActiveTurn,
  ) {
    const sessionID = Session.ID.make(sessionId);
    const sending = () => {
      if (state.active !== turn || turn.interrupted) return false;
      turn.unsent = false;
      return true;
    };
    const text = turnInput.message.text.trim();
    const bare = turnInput.message.attachments.length === 0;
    const id = turnPromptId(sessionId, turnInput.attemptId);
    if (bare && text === "/compact") {
      if (!sending()) return;
      return yield* live.client.session.compact({ sessionID, id }).pipe(Effect.asVoid);
    }
    const location = { directory: turnInput.runtimePolicy.cwd ?? host.paths.cwd };
    const command = bare ? commandOf(text) : undefined;
    if (command !== undefined) {
      const commands = yield* live.client.command.list({ location }).pipe(
        Effect.timeout(INVENTORY_TIMEOUT),
        Effect.map((list) => list.data),
        Effect.orElseSucceed(() => []),
      );
      if (commands.some((entry) => entry.name === command.name)) {
        // session.command neither accepts nor returns our ID; record the preceding history boundary.
        const newest = yield* live.client.message.list({ sessionID, order: "desc", limit: 1 });
        yield* markBefore(sessionId, newest.data[0]?.id ?? null);
        if (!sending()) return;
        return yield* live.client.session.command({ sessionID, ...command });
      }
    }
    const mentions = skillMentions(text);
    const skills = mentions.length === 0 ? [] : yield* skillsMentioned(location, mentions);
    const files = yield* promptFiles(turnInput.message.attachments);
    const messageText = yield* promptText(turnInput);
    if (!sending()) return;
    return yield* live.client.session
      .prompt({
        sessionID,
        id,
        text: messageText,
        ...(files.length === 0 ? {} : { files }),
        ...(skills.length === 0
          ? {}
          : { skills: skills.map((id) => ({ id: Skill.ID.make(id) })) }),
      })
      .pipe(Effect.asVoid);
  });

  return {
    register,
    ensureQuiet,
    cancelStrandedSteers,
    clearRevert,
    rollBackTo,
    userMessages,
    snapshotOf,
    promptText,
    promptFiles,
    markBefore,
    beginTurn,
    takeRunningWake,
    runWake,
    stopBackground,
    submit,
  };
};

export type TurnStart = ReturnType<typeof makeTurnStart>;
