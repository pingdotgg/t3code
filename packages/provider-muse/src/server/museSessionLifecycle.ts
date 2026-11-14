import * as Cause from "effect/Cause";
import * as Scope from "effect/Scope";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { MspError, type ProcessExit, type SendUserTurnOptions } from "@muse-code/sdk";
import type {
  ModelSelection,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import { MUSE_PROVIDER } from "./museCapabilities.ts";
import { museModelCapabilities, resolveMuseReasoningEffort } from "./modelCatalog.ts";
import type { MuseSessionCore } from "./museSessionCore.ts";
import type { MuseSessionEvents } from "./museSessionEvents.ts";
import type { ActiveTurn } from "./museSessionTypes.ts";
import { MuseCompactResult, MuseSessionResult, MuseTurnStartResult } from "./protocol.ts";
import { createMuseSdkHostEffect, museApprovalMode, musePermissionProfile } from "./sdk.ts";

/** The adapter-facing surface: thread registration, turns, snapshots, and the session runtime. */
export const makeMuseSessionLifecycle = Effect.fn("makeMuseSessionLifecycle")(function* (
  core: MuseSessionCore,
  sessionEvents: MuseSessionEvents,
) {
  const {
    input,
    options,
    idAllocator,
    providerHost,
    fileSystem,
    mcpSessions,
    agentScope,
    scope,
    cwd,
    workspaceRoot,
    now,
    state,
    events,
    inbox,
    commands,
    eventPermit,
    agentEndedAt,
    resolveModel,
    pending,
    seenTerminals,
    observedChildren,
    childrenByItemId,
    agentTitles,
    finishedBackground,
    emit,
    decode,
    request,
    updateSession,
    updateThread,
    itemIdentity,
    baseItem,
    childItemIdentity,
    itemStatus,
    publishChildRoot,
    publishChildMessage,
    ensureChildContext,
    publishNativeSubagent,
    publishWorkflowAgents,
    syncBackground,
    publishItem,
    settleObservedChildren,
    resolvePending,
    finish,
    failHost,
    owns,
    backgroundTaskId,
    nativeRef,
    protocolError,
    recordSchema,
    INFORMATIONAL_NOTIFICATIONS,
    responseAnswerSchema,
    isProtocolError,
    snapshot,
  } = core;
  const launchHost = Effect.fnUntraced(function* () {
    const epoch = ++state.hostEpoch;
    const mcpSession = yield* mcpSessions.read(input.threadId);
    const environment = McpProviderSession.withAgentDeviceEnvironment(
      options.environment,
      mcpSession,
    );
    const launch = yield* agentScope.wrap({
      command: options.settings.binaryPath || "muse",
      args: [],
      name: "muse",
      threadId: input.threadId,
      env: environment,
    });
    // Finalizers run in reverse order: reap detached work after closing the host.
    const scopeUnit = launch.unit;
    const stopScope =
      scopeUnit === undefined ? Effect.void : yield* Effect.cached(agentScope.stop(scopeUnit));
    yield* Scope.addFinalizer(scope, stopScope);
    const processExited = yield* Deferred.make<ProcessExit>();
    // Observe raw exit before acquisition: inherited stdout can also block startup cleanup.
    yield* Deferred.await(processExited).pipe(Effect.andThen(stopScope), Effect.forkIn(scope));
    const created = yield* Effect.acquireRelease(
      createMuseSdkHostEffect(
        {
          binaryPath: launch.command,
          launchArgs: launch.args,
          cwd,
          environment,
          runtimeMode: input.runtimePolicy.runtimeMode,
          onProcessExit: (exit) => {
            Deferred.doneUnsafe(processExited, Effect.succeed(exit));
          },
        },
        options.createHost,
      ).pipe(
        Effect.mapError(
          (error) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: MUSE_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause: error.cause,
            }),
        ),
      ),
      (created) =>
        Effect.gen(function* () {
          if (state.host === created) {
            state.closed = true;
            state.hostEpoch++;
          }
          const close = Effect.tryPromise(() => created.close());
          // SDK shutdown sends SIGKILL after 10s + 2s, but inherited pipes can
          // keep its close promise pending. Let the scope reap those holders.
          yield* (
            scopeUnit === undefined
              ? close
              : close.pipe(Effect.interruptible, Effect.timeoutOption("13 seconds"))
          ).pipe(Effect.ignore);
        }),
      { interruptible: true },
    ).pipe(Effect.provideService(Scope.Scope, scope));
    state.host = created;
    created.connection.onNotification((notification) => {
      Queue.offerUnsafe(inbox, {
        type: "notification",
        method: notification.method,
        params: notification.params,
        epoch,
      });
    });
    created.connection.onProtocolError((cause) => {
      Queue.offerUnsafe(inbox, { type: "failure", cause, epoch });
    });
    created.connection.onServerRequest(async (request) => {
      if (request.method === "approval/request" || request.method === "userInput/request")
        return {};
      throw new Error(`Unsupported Muse server request: ${request.method}`);
    });
    void created.connection.closed.then(() => {
      if (!state.closed && epoch === state.hostEpoch)
        Queue.offerUnsafe(inbox, {
          type: "failure",
          cause: new Error("Muse connection closed unexpectedly"),
          epoch,
        });
    });
    const reportExit = (exit: ProcessExit) => {
      if (!state.closed && epoch === state.hostEpoch) {
        const reason = created
          .stderrTail?.()
          .findLast((line) => line.trim())
          ?.trim();
        Queue.offerUnsafe(inbox, {
          type: "failure",
          cause: new Error(
            `Muse exited unexpectedly (${exit.code ?? exit.signal})${reason ? `: ${reason}` : ""}`,
          ),
          epoch,
        });
      }
    };
    void created.exited.then(reportExit);
    yield* Deferred.await(processExited).pipe(
      Effect.tap((exit) => Effect.sync(() => reportExit(exit))),
      Effect.forkIn(scope),
    );
  });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      state.closed = true;
      state.hostEpoch++;
      if (state.active) yield* finish(state.active, "cancelled", "Muse session closed", "broken");
      yield* settleObservedChildren("cancelled");
      yield* Queue.shutdown(inbox);
      yield* Queue.shutdown(events);
    }).pipe(eventPermit.withPermits(1)),
  );
  yield* launchHost();


    const { handleNotification, decideApproval } = sessionEvents;
  const register = Effect.fnUntraced(function* (
    args: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
  ) {
    if (state.closed || (state.broken && !state.relaunchable))
      return yield* protocolError("Muse host is unavailable; reopen the session");
    if (state.broken) {
      yield* Effect.logWarning("Relaunching the Muse host after a failure");
      yield* launchHost();
      state.broken = false;
      state.relaunchable = false;
      state.thread = undefined;
      state.nativeSessionId = undefined;
      yield* updateSession("ready", null);
    }
    if (state.active)
      return yield* protocolError("Cannot change Muse sessions during an active turn");
    const existing = args.existingProviderThread;
    if (
      existing &&
      (existing.driver !== MUSE_PROVIDER || existing.providerInstanceId !== options.instanceId)
    )
      return yield* protocolError("Muse thread belongs to another provider instance");
    const requestedId = existing
      ? (existing.nativeThreadRef?.nativeId ?? undefined)
      : input.initialNativeThreadId;
    if (
      state.thread &&
      (!requestedId || requestedId === state.nativeSessionId) &&
      state.thread.appThreadId === args.threadId
    )
      return state.thread;
    if (state.thread) return yield* protocolError("Open a new host to attach another Muse session");
    let missingNativeSession = false;
    return yield* Effect.gen(function* () {
      state.nativeSessionId = requestedId ?? state.host!.connection.mintCommandId();
      const mcpSession = yield* mcpSessions.read(args.threadId);
      if (mcpSession && !state.host!.initializeResult.grantedCapabilities.includes("sessionMcp"))
        return yield* protocolError(
          "Update Muse Code to a version that supports session MCP servers",
        );
      const config = mcpSession
        ? {
            mcpServers: {
              // Muse's required default fails runs if T3 tools are unreachable; make them optional.
              "t3-code": {
                transport: "streamableHttp",
                mode: "optional",
                url: mcpSession.endpoint,
                headers: { Authorization: mcpSession.authorizationHeader },
              },
            },
          }
        : undefined;
      const startModel = yield* resolveModel(args.modelSelection);
      const permissionProfile = musePermissionProfile(args.runtimePolicy.runtimeMode);
      const result = yield* request(
        requestedId ? "session/resume" : "session/start",
        requestedId
          ? { excludeItems: true, ...(config ? { config } : {}), permissionProfile }
          : {
              workspaceRoot: cwd,
              ...(config ? { config } : {}),
              ...(startModel ? { modelId: startModel } : {}),
              providerId: "meta",
              approvalMode: museApprovalMode(args.runtimePolicy.runtimeMode),
              permissionProfile,
            },
      ).pipe(
        Effect.catch((error) => {
          missingNativeSession =
            requestedId !== undefined &&
            error.payload instanceof MspError &&
            (error.payload.kind === "sessionNotFound" || error.payload.kind === "notFound");
          return Effect.fail(error);
        }),
        Effect.flatMap((value) => decode(MuseSessionResult, value)),
      );
      if (result.session.sessionId !== state.nativeSessionId)
        return yield* protocolError("Muse returned a different session identity");
      if (requestedId)
        yield* request("session/setApprovalMode", {
          mode: museApprovalMode(args.runtimePolicy.runtimeMode),
        });
      const createdAt = yield* DateTime.now;
      state.thread = existing
        ? {
            ...existing,
            providerSessionId: input.providerSessionId,
            nativeThreadRef: nativeRef(result.session.sessionId),
            status: "idle",
            updatedAt: createdAt,
          }
        : {
            id: idAllocator.derive.providerThread({
              driver: MUSE_PROVIDER,
              providerInstanceId: options.instanceId,
              nativeThreadId: state.nativeSessionId,
            }),
            driver: MUSE_PROVIDER,
            providerInstanceId: options.instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: args.threadId,
            ownerNodeId: null,
            nativeThreadRef: nativeRef(state.nativeSessionId),
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt,
            updatedAt: createdAt,
          };
      state.session = {
        ...state.session,
        model: result.session.modelId ?? args.modelSelection.model,
      };
      yield* emit({
        type: "provider_thread.updated",
        driver: MUSE_PROVIDER,
        providerThread: state.thread,
      });
      return state.thread;
    }).pipe(
      Effect.onError((cause) =>
        missingNativeSession ? Effect.void : eventPermit.withPermits(1)(failHost(cause)),
      ),
    );
  });
  const prompt = Effect.fnUntraced(function* (
    message: ProviderAdapter.ProviderAdapterV2TurnMessage,
  ) {
    const parts: SendUserTurnOptions<unknown>["input"] = [];
    const text = yield* providerMessageTextWithAttachmentPaths({
      text: message.text,
      attachments: message.attachments,
      resolveAttachmentPath: providerHost.resolveAttachmentPath,
      resolveExtractedTextPath: providerHost.resolveExtractedTextPath,
    });
    if (text) parts.push({ type: "text", text });
    for (const attachment of message.attachments)
      if (isProviderNativeImageAttachment(attachment)) {
        const path = providerHost.resolveAttachmentPath(attachment);
        if (!path) return yield* protocolError("Muse image attachment is missing");
        const bytes = yield* fileSystem
          .readFile(path)
          .pipe(Effect.mapError((cause) => protocolError("Cannot read Muse image", cause)));
        parts.push({
          type: "image",
          base64Data: Buffer.from(bytes).toString("base64"),
          mediaType: attachment.mimeType,
        });
      }
    if (!parts.length) return yield* protocolError("Muse needs text or an image");
    return parts;
  });
  const validateThread = (candidate: OrchestrationV2ProviderThread) =>
    state.thread !== undefined &&
    candidate.driver === MUSE_PROVIDER &&
    candidate.providerInstanceId === options.instanceId &&
    candidate.appThreadId === state.thread.appThreadId &&
    candidate.nativeThreadRef?.nativeId === state.nativeSessionId;
  const selectionEffort = Effect.fnUntraced(function* (selection: ModelSelection) {
    if (selection.instanceId !== options.instanceId)
      return yield* protocolError("Model selection belongs to another Muse instance");
    const catalog = options.modelCatalog ? yield* options.modelCatalog : [];
    const model = yield* resolveModel(selection);
    const selected = getModelSelectionStringOptionValue(selection, "reasoningEffort");
    return resolveMuseReasoningEffort(
      catalog.find((entry) => entry.slug === model)?.capabilities ?? museModelCapabilities(),
      selected,
    );
  });
  const start = Effect.fnUntraced(function* (
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
    compact = false,
  ) {
    if (!validateThread(turnInput.providerThread) || state.broken || state.closed)
      return yield* protocolError("Muse thread is not attached to this host");
    if (state.active)
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver: MUSE_PROVIDER,
        detail: "Muse already has an active turn; queue through the orchestrator",
        reason: "previous_turn_active",
      });
    if (turnInput.runtimePolicy.interactionMode === "plan")
      return yield* protocolError("Muse does not support dedicated Plan mode");
    if (turnInput.runtimePolicy.runtimeMode !== input.runtimePolicy.runtimeMode)
      return yield* protocolError("Runtime policy changes require a fresh Muse host");
    const continuation =
      turnInput.message.createdBy === "agent" &&
      turnInput.message.creationSource === "provider";
    const adopted = continuation ? state.wake : undefined;
    const effort = continuation ? undefined : yield* selectionEffort(turnInput.modelSelection);
    const parts = compact || continuation ? [] : yield* prompt(turnInput.message);
    const targetModel = continuation
      ? undefined
      : yield* resolveModel(turnInput.modelSelection);
    if (targetModel && state.session.model !== targetModel) {
      yield* request("session/setModel", {
        model: { modelId: targetModel, providerId: "meta" },
      });
      state.session = { ...state.session, model: targetModel };
    }
    const nativeId = adopted?.nativeId ?? state.host!.connection.mintCommandId();
    const startedAt = yield* DateTime.now;
    const providerTurn: OrchestrationV2ProviderTurn = {
      id: idAllocator.derive.providerTurn({
        driver: MUSE_PROVIDER,
        nativeTurnId: `${options.instanceId}:${state.nativeSessionId}:${nativeId}`,
      }),
      providerThreadId: turnInput.providerThread.id,
      nodeId: turnInput.rootNodeId,
      runAttemptId: turnInput.attemptId,
      nativeTurnRef: compact
        ? { ...nativeRef(nativeId), strength: "weak" }
        : nativeRef(nativeId),
      ordinal: turnInput.providerTurnOrdinal,
      status: "running",
      startedAt,
      completedAt: null,
    };
    const turn: ActiveTurn = {
      input: turnInput,
      providerTurn,
      nativeId,
      joined: new Set(),
      items: new Map(),
      ordinals: new Map(),
      started: new Map(),
      dirty: new Set(),
      settledRequests: new Set(),
      done: yield* Deferred.make<void>(),
      nextOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
      flushScheduled: false,
      interruptRequested: false,
      compact,
    };
    yield* Effect.gen(function* () {
      state.thread = turnInput.providerThread;
      state.active = turn;
      yield* emit({
        type: "provider_turn.updated",
        driver: MUSE_PROVIDER,
        threadId: turnInput.threadId,
        providerTurn,
      });
      yield* updateThread({
        status: "active",
        firstRunOrdinal: state.thread.firstRunOrdinal ?? turnInput.runOrdinal,
        lastRunOrdinal: turnInput.runOrdinal,
      });
      yield* updateSession("running");
      const held = state.wake;
      state.wake = undefined;
      if (continuation && !held) return yield* finish(turn, "completed");
      if (held && !continuation) turn.joined.add(held.nativeId);
      for (const [method, data] of held?.events ?? [])
        yield* handleNotification(method, data).pipe(Effect.catch(failHost));
    }).pipe(eventPermit.withPermits(1));
    if (continuation) return;
    yield* Effect.gen(function* () {
      if (compact) {
        const result = yield* request("session/compact", {}, true, nativeId).pipe(
          Effect.flatMap((value) => decode(MuseCompactResult, value)),
        );
        if (result.status === "noop")
          yield* eventPermit.withPermits(1)(
            finish(turn, "failed", result.reason ?? "Muse has no context to compact."),
          );
        else if (result.status !== "accepted")
          return yield* protocolError(
            `Muse returned an unsupported compaction status: ${result.status}`,
          );
      } else {
        const result = yield* request(
          "turn/start",
          {
            input: [
              {
                type: "text",
                text: buildRuntimeInstructions({
                  harness: "Muse Code",
                  model: state.session.model ?? undefined,
                  reasoningEffort: effort,
                }),
              },
              ...parts,
            ],
            displayText: turnInput.message.text || "Image attachment",
            // Resumed sessions retain old roots; pin edits to the current checkout.
            workspaceRoots: [workspaceRoot],
            ifBusy: "queue",
            ...(effort ? { reasoningEffort: effort } : {}),
          },
          true,
          nativeId,
        ).pipe(Effect.flatMap((value) => decode(MuseTurnStartResult, value)));
        if (result.turnId !== nativeId) {
          yield* eventPermit.withPermits(1)(
            failHost(new Error("Muse admitted an unowned turn")),
          );
          return yield* protocolError("Muse admitted the turn under an unexpected identity");
        }
      }
    }).pipe(
      Effect.onError((cause) => {
        const error = Cause.squash(cause);
        const detail = isProtocolError(error)
          ? error.detail
          : error instanceof Error
            ? error.message
            : "Muse could not start the turn.";
        return eventPermit.withPermits(1)(finish(turn, "failed", detail));
      }),
    );
  });
  const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
    instanceId: options.instanceId,
    driver: MUSE_PROVIDER,
    providerSessionId: input.providerSessionId,
    providerSession: state.session,
    events: Stream.fromQueue(events),
    backgroundTasksEndWithProcess: true,
    // A running workflow or a held Muse turn keeps the state.host: idle release must wait.
    hasPendingBackgroundWork: Effect.sync(
      () => observedChildren.size > 0 || state.wake !== undefined,
    ),
    ensureThread: (args) =>
      register(args).pipe(
        commands.withPermits(1),
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterEnsureThreadError({
              driver: MUSE_PROVIDER,
              threadId: args.threadId,
              cause,
            }),
        ),
      ),
    resumeThread: (args) =>
      register({
        threadId: args.threadId ?? args.providerThread.appThreadId ?? input.threadId,
        modelSelection: args.modelSelection ?? input.modelSelection,
        runtimePolicy: args.runtimePolicy ?? input.runtimePolicy,
        existingProviderThread: args.providerThread,
      }).pipe(
        commands.withPermits(1),
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterResumeThreadError({
              driver: MUSE_PROVIDER,
              providerSessionId: input.providerSessionId,
              providerThreadId: args.providerThread.id,
              cause,
            }),
        ),
      ),
    startTurn: (args) =>
      start(args).pipe(
        commands.withPermits(1),
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: MUSE_PROVIDER,
              threadId: args.threadId,
              providerThreadId: args.providerThread.id,
              runId: args.runId,
              cause,
            }),
        ),
      ),
    compactThread: (args) => start(args, true).pipe(commands.withPermits(1)),
    steerTurn: Effect.fn("MuseAdapter.steerTurn")(
      function* (args) {
        const turn = state.active;
        if (
          !turn ||
          turn.providerTurn.id !== args.providerTurnId ||
          !validateThread(args.providerThread) ||
          turn.compact
        )
          return yield* protocolError("This Muse turn cannot be steered");
        const parts = yield* prompt(args.message);
        const result = yield* request("turn/steer", {
          expectedTurnId: turn.nativeId,
          input: parts,
        }).pipe(Effect.flatMap((value) => decode(MuseTurnStartResult, value)));
        if (result.turnId !== turn.nativeId)
          return yield* protocolError("Muse steering targeted a different turn");
      },
      (effect, args) =>
        effect.pipe(
          commands.withPermits(1),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterSteerRunError({
                driver: MUSE_PROVIDER,
                providerThreadId: args.providerThread.id,
                providerTurnId: args.providerTurnId,
                cause,
              }),
          ),
        ),
    ),
    interruptTurn: Effect.fn("MuseAdapter.interruptTurn")(
      function* (args) {
        const turn = state.active;
        if (
          !turn ||
          turn.providerTurn.id !== args.providerTurnId ||
          !validateThread(args.providerThread)
        )
          return yield* protocolError("This Muse turn is no longer active");
        turn.interruptRequested = true;
        if (turn.compact) {
          yield* eventPermit.withPermits(1)(
            Effect.gen(function* () {
              if (state.active !== turn) return;
              state.hostEpoch++;
              yield* Effect.tryPromise(() => state.host!.close()).pipe(
                Effect.mapError((cause) => protocolError("Cannot stop Muse compaction", cause)),
                Effect.onError(failHost),
              );
              state.broken = true;
              yield* finish(turn, "interrupted", undefined, "broken");
              yield* settleObservedChildren("interrupted");
              yield* updateSession("stopped");
              yield* Queue.end(events);
            }),
          );
          return;
        }
        // Muse runs a joined turn first, so Stop must end it too.
        for (const joined of turn.joined)
          yield* request("turn/interrupt", { turnId: joined }).pipe(Effect.ignore);
        yield* request("turn/interrupt", { turnId: turn.nativeId });
        yield* Deferred.await(turn.done).pipe(
          Effect.timeout(options.requestTimeoutMs ?? 30_000),
          Effect.mapError((cause) => protocolError("Muse did not confirm interruption", cause)),
          Effect.onError((cause) => eventPermit.withPermits(1)(failHost(cause))),
        );
      },
      (effect, args) =>
        effect.pipe(
          commands.withPermits(1),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterInterruptError({
                driver: MUSE_PROVIDER,
                providerThreadId: args.providerThread.id,
                providerTurnId: args.providerTurnId,
                cause,
              }),
          ),
        ),
    ),
    respondToRuntimeRequest: Effect.fn("MuseAdapter.respondToRuntimeRequest")(
      function* (args) {
        const entry = pending.get(args.requestId);
        if (!entry) return yield* protocolError("This Muse request is no longer pending");
        if (entry.native.type === "approval") yield* decideApproval(entry, args.decision);
        else {
          const questionRequest = entry.native.value;
          const answers = [];
          for (const question of questionRequest.questions) {
            const raw = yield* decode(responseAnswerSchema, args.answers?.[question.id]);
            const values = typeof raw === "string" ? [raw] : [...new Set(raw)];
            const selected = values.filter((value) =>
              question.options.some((option) => option.label === value),
            );
            const freeText = values.filter((value) => !selected.includes(value)).join("\n");
            if (freeText.length > 500 || (!freeText && !selected.length))
              return yield* protocolError(
                "Muse needs a nonempty answer with at most 500 custom characters",
              );
            if (
              (question.selection.mode === "single" && selected.length > 1) ||
              (selected.length > 0 &&
                (selected.length < (question.selection.minSelections ?? 0) ||
                  selected.length > (question.selection.maxSelections ?? Infinity)))
            )
              return yield* protocolError("Muse question selection count is invalid");
            answers.push({
              questionId: question.id,
              ...(selected.length
                ? question.selection.mode === "single"
                  ? { selectedLabel: selected[0]! }
                  : { selectedLabels: selected }
                : {}),
              ...(freeText ? (selected.length ? { note: freeText } : { freeText }) : {}),
            });
          }
          if (args.answers) entry.response = { answers: args.answers };
          yield* request("userInput/answer", {
            userInputId: questionRequest.userInputId,
            answers,
          }).pipe(Effect.tapError(() => Effect.sync(() => delete entry.response)));
        }
      },
      (effect, args) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                driver: MUSE_PROVIDER,
                requestId: args.requestId,
                cause,
              }),
          ),
        ),
    ),
    readThreadSnapshot: (args) =>
      (!validateThread(args.providerThread)
        ? protocolError("Snapshot requested for a different Muse thread")
        : snapshot(args.providerThread)
      ).pipe(
        commands.withPermits(1),
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
              driver: MUSE_PROVIDER,
              providerThreadId: args.providerThread.id,
              cause,
            }),
        ),
      ),
    // Muse rejects completed-turn forks with InvalidCut; use portable handoff without rewinding.
    rollbackThread: (args) =>
      Effect.fail(
        new ProviderAdapter.ProviderAdapterRollbackThreadError({
          driver: MUSE_PROVIDER,
          providerThreadId: args.providerThread.id,
          checkpointId: args.target.checkpointId,
          cause: "Muse Code does not support conversation rollback in T3 Code.",
        }),
      ),
    forkThread: (args) =>
      Effect.fail(
        new ProviderAdapter.ProviderAdapterForkThreadError({
          driver: MUSE_PROVIDER,
          providerThreadId: args.sourceProviderThread.id,
          cause: "Muse Code does not support native forks in T3 Code.",
        }),
      ),
  };
    return runtime;
});

export type MuseSessionLifecycle = Effect.Success<ReturnType<typeof makeMuseSessionLifecycle>>;
