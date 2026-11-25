import * as NodeUtil from "node:util";
import {
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type PlanId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2UserInputQuestion,
  RuntimeRequestId,
  type ProviderInstanceId,
  parseGoalCommand,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import { withAgentDeviceEnvironment } from "@t3tools/provider-core/server/mcpSession";
import {
  resumeTurnInput,
  type ProviderAdapterV2,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2ForkThreadInput,
  type ProviderAdapterV2OpenSessionInput,
  type ProviderAdapterV2ReadThreadSnapshotInput,
  type ProviderAdapterV2RollbackThreadInput,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2SteerInput,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { dialogAnswer, readQuestions } from "./dialog.ts";
import { readOmpForm } from "./form.ts";
import { readOmpQueueRecovery } from "./queueRecovery.ts";
import { makeOmpHostTools } from "./hostTools.ts";
import { OMP_RPC_PROVIDER } from "../settings.ts";
import {
  contentText,
  goalRequest,
  modelSlug,
  ompApprovalMode,
  ompCapabilities,
  readGoal,
  readSideQuestionCommand,
  readSlashCommands,
  readSubagentCommand,
  readTodoSteps,
  readTokenUsage,
} from "./protocol.ts";
import { array, ompProtocolError, openOmpRpc, record, string } from "./rpc.ts";
import { readSessionCommand } from "./sessionCommands.ts";

const driver = OMP_RPC_PROVIDER;
const nativeRef = (nativeId: string, strength: "weak" | "strong" = "strong") => ({
  driver,
  nativeId,
  strength,
});
const unsupported = (feature: string) =>
  Effect.fail(ompProtocolError(`Oh My Pi RPC does not support ${feature} in T3 Code`));

interface ActiveTurn {
  input: ProviderAdapterV2TurnInput;
  turn: OrchestrationV2ProviderTurn;
  done: Deferred.Deferred<void>;
  rows: Map<string, OrchestrationV2TurnItem>;
  messageIndex: number;
  lastMessageUsage?: unknown;
  todoPlanId?: PlanId;
  sideQuestion?: { recordId: string | undefined; answer: string };
  awaitingPrompt: boolean;
  acknowledged: boolean;
  status: "completed" | "failed" | "interrupted";
  error?: string;
  recoveringQueue?: boolean;
  postponedFinish?: { broken: boolean };
}

export const makeOmpAdapter = Effect.fn("OmpAdapter.make")(function* (options: {
  instanceId: ProviderInstanceId;
  binaryPath: string;
  enabled: boolean;
  environment: NodeJS.ProcessEnv;
  onCommandsUpdated?: (
    cwd: string,
    commands: ReadonlyArray<ServerProviderSlashCommand>,
  ) => Effect.Effect<void>;
}) {
  const host = yield* ProviderHost;
  const id = yield* IdAllocatorV2;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const mcpSessions = yield* McpProviderSessions;

  const openSession = Effect.fn("OmpAdapter.openSession")(function* (
    input: ProviderAdapterV2OpenSessionInput,
  ) {
    if (!options.enabled) return yield* unsupported("disabled instances");
    const approvalMode = ompApprovalMode(input.runtimePolicy.runtimeMode);
    if (approvalMode === undefined || input.runtimePolicy.interactionMode === "plan") {
      return yield* unsupported("this runtime policy");
    }
    const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
    const config = yield* fs
      .makeTempFileScoped({ prefix: "t3-omp-", suffix: ".yml" })
      .pipe(
        Effect.mapError((cause) =>
          ompProtocolError("Could not create the Oh My Pi session config", cause),
        ),
      );
    yield* fs
      .writeFileString(
        config,
        "goal:\n  continuationModes: [interactive, rpc]\ndev:\n  autoqa: false\n",
      )
      .pipe(
        Effect.mapError((cause) =>
          ompProtocolError("Could not write the Oh My Pi session config", cause),
        ),
      );
    const rpc = yield* openOmpRpc({
      binaryPath: options.binaryPath,
      args: [
        "--mode",
        "rpc",
        "--config",
        config,
        "--approval-mode",
        approvalMode,
        ...(input.initialNativeThreadId === undefined
          ? []
          : ["--resume", input.initialNativeThreadId]),
      ],
      cwd,
      environment: withAgentDeviceEnvironment(
        { ...options.environment, T3CODE_THREAD_ID: input.threadId },
        yield* mcpSessions.read(input.threadId),
      ),
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    const hostTools = yield* makeOmpHostTools(input.threadId, options.instanceId, rpc, mcpSessions);
    if (host.trackAgent)
      yield* Effect.acquireRelease(Effect.sync(host.trackAgent), (stop) => Effect.sync(stop));
    const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
    const emit = (event: ProviderAdapterV2Event) => Queue.offer(events, event).pipe(Effect.asVoid);
    const getState = () => rpc.request({ type: "get_state" }).pipe(Effect.map(record));
    let initial = yield* getState();
    if (options.onCommandsUpdated) {
      const catalog = yield* rpc.request({ type: "get_available_commands" }).pipe(
        Effect.timeout("2 seconds"),
        Effect.orElseSucceed(() => undefined),
      );
      if (catalog)
        yield* options.onCommandsUpdated(cwd, readSlashCommands(record(catalog).commands));
    }
    let acceptsImages = array(record(initial.model).input).includes("image");
    yield* rpc.request({ type: "goal", op: "get" });
    yield* rpc.request({ type: "set_ask_dialog", enabled: true });
    yield* rpc
      .request({ type: "set_subagent_subscription", level: "progress" })
      .pipe(Effect.ignore);
    let nativeId = string(initial.sessionFile);
    if (
      !nativeId ||
      (input.initialNativeThreadId !== undefined && input.initialNativeThreadId !== nativeId)
    ) {
      return yield* ompProtocolError("Oh My Pi did not open the requested persisted session");
    }
    const now = yield* DateTime.now;
    let session: OrchestrationV2ProviderSession = {
      id: input.providerSessionId,
      driver,
      providerInstanceId: options.instanceId,
      cwd,
      model: modelSlug(initial.model) ?? null,
      status: "ready",
      capabilities: ompCapabilities,
      createdAt: input.resumeFromSession?.createdAt ?? now,
      updatedAt: now,
      lastError: null,
    };
    let thread: OrchestrationV2ProviderThread | undefined;
    let entryCursor: string | undefined;
    let active: ActiveTurn | undefined;
    const subagents = new Map<string, OrchestrationV2Subagent>();
    const dialogs = new Map<
      RuntimeRequestId,
      {
        run: ActiveTurn;
        key: string;
        method: string;
        nativeId: string;
        questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
        item: OrchestrationV2TurnItem;
        request: OrchestrationV2RuntimeRequest;
      }
    >();
    const privateDialogs = new Map<
      OrchestrationV2TurnItem["id"],
      {
        run: ActiveTurn;
        key: string;
        nativeId: string;
        item: Extract<OrchestrationV2TurnItem, { type: "secret_request" }>;
        response: (
          values: Readonly<Record<string, string | ReadonlyArray<string>>>,
        ) => object | undefined;
      }
    >();
    let runtimeError: ReturnType<typeof ompProtocolError> | undefined;
    const updateSession = Effect.fnUntraced(function* (
      status: OrchestrationV2ProviderSession["status"],
      lastError: string | null = null,
    ) {
      session = { ...session, status, lastError, updatedAt: yield* DateTime.now };
      yield* emit({ type: "provider_session.updated", driver, providerSession: session });
    });
    const updateThread = Effect.fnUntraced(function* (
      patch: Partial<OrchestrationV2ProviderThread>,
      sessionScoped = active === undefined,
    ) {
      const updatedAt = yield* DateTime.now;
      if (thread === undefined) return;
      thread = { ...thread, ...patch, updatedAt };
      yield* emit({
        type: "provider_thread.updated",
        driver,
        providerThread: thread,
        ...(sessionScoped ? { sessionScoped: true } : {}),
      });
    });
    const bind = Effect.fnUntraced(function* (
      existing: OrchestrationV2ProviderThread | undefined,
      forceNew = false,
    ) {
      if (runtimeError) return yield* runtimeError;
      const requested = forceNew ? undefined : existing?.nativeThreadRef?.nativeId;
      if ((requested !== undefined && nativeId !== requested) || forceNew) {
        if (active) return yield* ompProtocolError("Oh My Pi is already running a turn");
        const result = record(
          yield* rpc.request(
            requested === undefined
              ? { type: "new_session" }
              : { type: "switch_session", sessionPath: requested },
          ),
        );
        if (result.cancelled === true)
          return yield* ompProtocolError("Oh My Pi cancelled the session switch");
        initial = yield* getState();
        acceptsImages = array(record(initial.model).input).includes("image");
        const next = string(initial.sessionFile);
        if (!next || next === nativeId || (requested !== undefined && next !== requested)) {
          return yield* ompProtocolError("Oh My Pi did not switch to the requested session");
        }
        nativeId = next;
        entryCursor = undefined;
        session = { ...session, model: modelSlug(initial.model) ?? null, extensionStatuses: [] };
      }
      if (!nativeId) return yield* ompProtocolError("Oh My Pi returned no session path");
      if (thread && thread.nativeThreadRef?.nativeId === nativeId && !forceNew) return thread;
      const time = yield* DateTime.now;
      const goal = record(yield* rpc.request({ type: "goal", op: "get" }));
      thread = {
        ...(existing ?? {
          id: id.derive.providerThread({
            driver,
            nativeThreadId: `${options.instanceId}:${nativeId}`,
          }),
          driver,
          providerInstanceId: options.instanceId,
          appThreadId: input.threadId,
          ownerNodeId: null,
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: time,
        }),
        providerSessionId: input.providerSessionId,
        nativeThreadRef: nativeRef(nativeId),
        nativeConversationHeadRef: forceNew ? null : (existing?.nativeConversationHeadRef ?? null),
        status: "idle",
        pendingBackgroundTasks: [],
        goal: readGoal(goal.goal),
        updatedAt: time,
      };
      return thread;
    });

    const applySelection = Effect.fnUntraced(function* (selection: ModelSelection) {
      const target = selection.model;
      if (target !== session.model && target !== "default") {
        const separator = target.indexOf("/");
        if (separator <= 0 || separator === target.length - 1) {
          return yield* ompProtocolError("Oh My Pi models use provider/model-id names");
        }
        const model = record(
          yield* rpc.request({
            type: "set_model",
            provider: target.slice(0, separator),
            modelId: target.slice(separator + 1),
          }),
        );
        acceptsImages = array(model.input).includes("image");
        session = { ...session, model: target };
      }
      const thinking = getModelSelectionStringOptionValue(selection, "thinking");
      if (thinking !== undefined)
        yield* rpc.request({ type: "set_thinking_level", level: thinking });
    });
    const baseItem = (run: ActiveTurn, key: string, time: DateTime.Utc) => {
      const previous = run.rows.get(key);
      const identity = { driver, nativeItemId: `${run.turn.id}:${key}` };
      return {
        id: previous?.id ?? id.derive.turnItemFromProviderItem(identity),
        nodeId: previous?.nodeId ?? id.derive.nodeFromProviderItem(identity),
        threadId: run.input.threadId,
        runId: run.input.runId,
        providerThreadId: run.turn.providerThreadId,
        providerTurnId: run.turn.id,
        nativeItemRef: nativeRef(key, "weak"),
        parentItemId: null,
        ordinal: previous?.ordinal ?? run.input.providerTurnOrdinal * 100 + run.rows.size + 1,
        startedAt: previous?.startedAt ?? time,
        updatedAt: time,
      };
    };
    const publish = Effect.fnUntraced(function* (
      run: ActiveTurn,
      key: string,
      item: OrchestrationV2TurnItem,
    ) {
      run.rows.set(key, item);
      const kind =
        item.type === "assistant_message"
          ? "assistant_message"
          : item.type === "reasoning"
            ? "reasoning"
            : item.type === "user_input_request" || item.type === "approval_request"
              ? item.type
              : item.type === "todo_list"
                ? "todo_list"
                : "tool_call";
      yield* emit({
        type: "node.updated",
        driver,
        node: {
          id: item.nodeId!,
          threadId: run.input.threadId,
          runId: run.input.runId,
          parentNodeId: run.input.rootNodeId,
          rootNodeId: run.input.rootNodeId,
          kind,
          status: item.status,
          countsForRun: false,
          providerThreadId: run.turn.providerThreadId,
          providerTurnId: run.turn.id,
          nativeItemRef: item.nativeItemRef,
          runtimeRequestId:
            item.type === "user_input_request" || item.type === "approval_request"
              ? item.requestId
              : null,
          checkpointScopeId: null,
          startedAt: item.startedAt,
          completedAt: item.completedAt,
        },
      });
      if (item.type === "assistant_message") {
        yield* emit({
          type: "message.updated",
          driver,
          message: {
            id: item.messageId,
            threadId: run.input.threadId,
            runId: run.input.runId,
            nodeId: item.nodeId,
            role: "assistant",
            text: item.text,
            attachments: [],
            streaming: item.streaming,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: item.startedAt ?? item.updatedAt,
            updatedAt: item.updatedAt,
          },
        });
      }
      yield* emit({ type: "turn_item.updated", driver, turnItem: item });
    });
    const publishTodos = Effect.fnUntraced(function* (
      run: ActiveTurn,
      phases: unknown,
      explicit = false,
    ) {
      const steps = readTodoSteps(phases);
      if (steps === undefined || (steps.length === 0 && run.todoPlanId === undefined && !explicit))
        return;
      const planId =
        run.todoPlanId ??
        (yield* id.allocate
          .plan({
            driver,
            threadId: run.input.threadId,
            ...(run.input.runId === null ? {} : { runId: run.input.runId }),
          })
          .pipe(Effect.orElseSucceed(() => undefined)));
      if (!planId) return;
      run.todoPlanId = planId;
      const time = yield* DateTime.now;
      const key = "todos";
      const base = baseItem(run, key, time);
      if (base.nodeId === null) return;
      yield* publish(run, key, {
        ...base,
        type: "todo_list",
        title: null,
        planId,
        steps,
        status: "completed",
        completedAt: time,
      });
      yield* emit({
        type: "plan.updated",
        driver,
        plan: {
          id: planId,
          threadId: run.input.threadId,
          runId: run.input.runId,
          nodeId: base.nodeId,
          kind: "todo_list",
          status: steps.every((step) => step.status === "completed") ? "completed" : "active",
          steps,
        },
      });
    });
    const publishLocalText = Effect.fnUntraced(function* (
      run: ActiveTurn,
      key: string,
      text: string,
      streaming = false,
    ) {
      const time = yield* DateTime.now;
      yield* publish(run, key, {
        ...baseItem(run, key, time),
        type: "assistant_message",
        messageId: id.derive.messageFromProviderItem({
          driver,
          nativeItemId: `${run.turn.id}:${key}`,
        }),
        title: null,
        text,
        streaming,
        status: streaming ? "running" : run.status,
        completedAt: streaming ? null : time,
      });
    });
    const settleDialog = Effect.fnUntraced(function* (
      requestId: RuntimeRequestId,
      status: "resolved" | "cancelled",
    ) {
      const dialog = dialogs.get(requestId);
      if (!dialog) return;
      dialogs.delete(requestId);
      const time = yield* DateTime.now;
      yield* publish(dialog.run, dialog.key, {
        ...dialog.item,
        status: status === "resolved" ? "completed" : "cancelled",
        completedAt: time,
        updatedAt: time,
      });
      yield* emit({
        type: "runtime_request.updated",
        driver,
        threadId: dialog.run.input.threadId,
        runtimeRequest: { ...dialog.request, status, resolvedAt: time },
      });
    });
    const settlePrivateDialog = Effect.fnUntraced(function* (
      itemId: OrchestrationV2TurnItem["id"],
      status: "saved" | "declined" | "cancelled",
    ) {
      const dialog = privateDialogs.get(itemId);
      if (!dialog) return;
      privateDialogs.delete(itemId);
      const time = yield* DateTime.now;
      yield* publish(dialog.run, dialog.key, {
        ...dialog.item,
        secretStatus: status,
        status: status === "saved" ? "completed" : "cancelled",
        completedAt: time,
        updatedAt: time,
      });
    });
    const readConversationHead = Effect.fnUntraced(function* () {
      const since = entryCursor;
      const entries = record(
        yield* rpc.request({ type: "get_entries", ...(since ? { since } : {}) }).pipe(
          Effect.catchIf(
            () => since !== undefined,
            () => rpc.request({ type: "get_entries" }),
          ),
        ),
      );
      entryCursor = string(record(array(entries.entries).at(-1)).id) ?? entryCursor;
      return string(entries.leafId);
    });

    const finish = Effect.fnUntraced(function* (run: ActiveTurn, broken = false) {
      if (active !== run) return;
      if (run.recoveringQueue) {
        run.postponedFinish = { broken: broken || run.postponedFinish?.broken === true };
        return;
      }
      active = undefined;
      const time = yield* DateTime.now;
      for (const [requestId, dialog] of dialogs)
        if (dialog.run === run) yield* settleDialog(requestId, "cancelled");
      for (const [itemId, dialog] of privateDialogs)
        if (dialog.run === run) yield* settlePrivateDialog(itemId, "cancelled");
      for (const [key, row] of run.rows) {
        if (row.status !== "running") continue;
        yield* publish(run, key, {
          ...row,
          status: run.status,
          completedAt: time,
          updatedAt: time,
          ...(row.type === "assistant_message" || row.type === "reasoning"
            ? { streaming: false }
            : {}),
        });
      }
      const [tokenUsage, head] = broken
        ? [undefined, undefined]
        : yield* Effect.all(
            [
              rpc.request({ type: "get_session_stats" }).pipe(
                Effect.timeout("2 seconds"),
                Effect.map((stats) =>
                  readTokenUsage(stats, run.lastMessageUsage, DateTime.formatIso(time)),
                ),
                Effect.orElseSucceed(() => undefined),
              ),
              readConversationHead().pipe(
                Effect.timeout("2 seconds"),
                Effect.orElseSucceed(() => undefined),
              ),
            ],
            { concurrency: 2 },
          );
      yield* emit({
        type: "provider_turn.updated",
        driver,
        threadId: run.input.threadId,
        providerTurn: {
          ...run.turn,
          status: run.status,
          completedAt: time,
          ...(head ? { nativeTurnRef: nativeRef(head) } : {}),
          ...(tokenUsage ? { tokenUsage } : {}),
        },
      });
      yield* updateThread(
        {
          status: broken ? "error" : "idle",
          ...(head ? { nativeConversationHeadRef: nativeRef(head) } : {}),
        },
        false,
      );
      yield* updateSession(broken ? "error" : "ready", run.error ?? null);
      const terminal = {
        type: "turn.terminal" as const,
        driver,
        providerThreadId: run.turn.providerThreadId,
        providerTurnId: run.turn.id,
        runOrdinal: run.input.runOrdinal,
        threadDisposition: broken ? ("broken" as const) : ("reusable" as const),
      };
      yield* emit(
        run.status === "failed"
          ? {
              ...terminal,
              status: "failed",
              failureItemOrdinal: run.input.providerTurnOrdinal * 100 + run.rows.size + 1,
              failure: makeProviderFailure({
                class: broken ? "transport_error" : "provider_error",
                message: run.error ?? "Oh My Pi turn failed.",
              }),
            }
          : { ...terminal, status: run.status, failure: null },
      );
      yield* Deferred.succeed(run.done, undefined);
    });

    const onSubagent = Effect.fnUntraced(function* (frame: Record<string, unknown>) {
      const payload = record(frame.payload);
      const progress = record(payload.progress);
      const nativeTaskId = string(payload.id) ?? string(progress.id);
      if (!nativeTaskId || !thread) return;
      const previous = subagents.get(nativeTaskId);
      const run = active;
      if (!previous && (!run || payload.status !== "started")) return;
      const status =
        payload.status === "started"
          ? "running"
          : payload.status === "aborted"
            ? "cancelled"
            : payload.status;
      if (
        status !== undefined &&
        status !== "running" &&
        status !== "completed" &&
        status !== "failed" &&
        status !== "cancelled"
      )
        return;
      const nextStatus = status ?? previous?.status ?? "running";
      const time = yield* DateTime.now;
      const task: OrchestrationV2Subagent = {
        ...(previous ?? {
          id: id.derive.nodeFromProviderItem({
            driver,
            nativeItemId: `${thread.id}:subagent:${nativeTaskId}`,
          }),
          threadId: input.threadId,
          runId: run!.input.runId,
          parentNodeId: run!.input.rootNodeId,
          providerThreadId: thread.id,
          childThreadId: null,
          origin: "provider_native",
          createdBy: "agent",
          driver,
          providerInstanceId: options.instanceId,
          nativeTaskRef: nativeRef(nativeTaskId),
          model: null,
          result: null,
          startedAt: time,
        }),
        title: string(payload.agent) ?? previous?.title ?? null,
        prompt: string(payload.task) ?? string(payload.assignment) ?? previous?.prompt ?? "",
        status: nextStatus,
        completedAt: nextStatus === "running" ? null : time,
        updatedAt: time,
      };
      if (nextStatus === "running") subagents.set(nativeTaskId, task);
      else subagents.delete(nativeTaskId);
      if (
        previous &&
        previous.status === task.status &&
        previous.title === task.title &&
        previous.prompt === task.prompt
      )
        return;
      yield* emit({ type: "subagent.updated", driver, subagent: task });
      yield* updateThread({
        pendingBackgroundTasks: [...subagents.entries()].map(([taskId, child]) => ({
          kind: "subagent" as const,
          taskId,
          providerInstanceId: options.instanceId,
          ...(child.title ? { description: child.title } : {}),
        })),
      });
    });

    const onFrame = Effect.fnUntraced(function* (frame: Record<string, unknown>) {
      if (frame.type === "host_tool_call" || frame.type === "host_tool_cancel") {
        yield* hostTools.onFrame(frame, active !== undefined);
        return;
      }
      if (frame.type === "subagent_lifecycle" || frame.type === "subagent_progress") {
        yield* onSubagent(frame);
        return;
      }
      if (frame.type === "available_commands_update") {
        yield* options.onCommandsUpdated?.(cwd, readSlashCommands(frame.commands)) ?? Effect.void;
        return;
      }
      if (frame.type === "config_update") {
        const model = modelSlug(frame.model);
        if (model !== undefined) {
          acceptsImages = array(record(frame.model).input).includes("image");
          if (session.model !== model) {
            session = { ...session, model };
            yield* updateSession(session.status, session.lastError);
          }
        }
        return;
      }
      if (frame.type === "goal_updated") {
        yield* updateThread({ goal: readGoal(frame.goal) });
        return;
      }
      const run = active;
      if (frame.type === "extension_ui_request") {
        if (frame.method === "setStatus" || frame.method === "setWidget") {
          const widget = frame.method === "setWidget";
          const name = string(widget ? frame.widgetKey : frame.statusKey)?.trim();
          if (!name) return;
          const key = (widget ? `widget:${name}` : name).slice(0, 256);
          const content = widget
            ? array(frame.widgetLines)
                .slice(0, 16)
                .map((line) => string(line)?.slice(0, 4096))
                .join("\n")
            : (string(frame.statusText) ?? "");
          const text = NodeUtil.stripVTControlCharacters(content).trim().slice(0, 4096);
          const statuses = session.extensionStatuses ?? [];
          if ((statuses.find((status) => status.key === key)?.text ?? "") === text) return;
          const next = statuses.filter((status) => status.key !== key);
          if (text) next.push({ key, text });
          session = { ...session, extensionStatuses: next.slice(-32) };
          yield* updateSession(session.status, session.lastError);
          return;
        }
        if (frame.method === "cancel") {
          for (const [requestId, dialog] of dialogs) {
            if (dialog.nativeId === frame.targetId) yield* settleDialog(requestId, "cancelled");
          }
          for (const [itemId, dialog] of privateDialogs) {
            if (dialog.nativeId === frame.targetId) yield* settlePrivateDialog(itemId, "cancelled");
          }
          return;
        }
        const nativeId = string(frame.id);
        const method = string(frame.method);
        if (method === "notify" && run && nativeId) {
          const text = NodeUtil.stripVTControlCharacters(string(frame.message) ?? "")
            .trim()
            .slice(0, 4096);
          if (text) yield* publishLocalText(run, `notification:${nativeId}`, text);
          return;
        }
        if (
          !nativeId ||
          !method ||
          !["confirm", "select", "input", "editor", "ask", "form"].includes(method)
        )
          return;
        if (!run) {
          yield* rpc.send({ type: "extension_ui_response", id: nativeId, cancelled: true });
          return;
        }
        if (method === "form" || frame.secret === true) {
          const form =
            method === "form" && typeof frame.html === "string"
              ? readOmpForm(frame.html)
              : undefined;
          if ((method === "form" && !form) || (method !== "form" && method !== "input")) {
            yield* rpc.send({ type: "extension_ui_response", id: nativeId, cancelled: true });
            return;
          }
          const key = `dialog:${nativeId}`;
          const time = yield* DateTime.now;
          const placeholder = string(frame.placeholder);
          const item = {
            ...baseItem(run, key, time),
            title: null,
            status: "waiting",
            completedAt: null,
            type: "secret_request",
            delivery: "provider",
            label: (form?.title || string(frame.title)?.trim() || "Oh My Pi").slice(0, 1024),
            reason: form?.reason ?? "",
            ...(form ? { fields: form.fields } : {}),
            ...(placeholder === undefined ? {} : { placeholder: placeholder.slice(0, 1024) }),
            secretStatus: "pending",
          } as const satisfies OrchestrationV2TurnItem;
          privateDialogs.set(item.id, {
            run,
            key,
            nativeId,
            item,
            response:
              form?.response ??
              ((values) => {
                const value = Object.hasOwn(values, "") ? values[""] : undefined;
                return typeof value === "string" &&
                  value.length <= 8192 &&
                  Object.keys(values).length === 1
                  ? { value }
                  : undefined;
              }),
          });
          yield* publish(run, key, item);
          return;
        }
        const questions = method === "confirm" ? [] : readQuestions(frame, nativeId);
        if (
          method !== "confirm" &&
          (questions.length === 0 || questions.some((question) => question === undefined))
        ) {
          yield* rpc.send({ type: "extension_ui_response", id: nativeId, cancelled: true });
          return;
        }
        const validQuestions = questions.filter((question) => question !== undefined);
        const key = `dialog:${nativeId}`;
        const requestId = RuntimeRequestId.make(`${run.turn.id}:${key}`);
        const time = yield* DateTime.now;
        const base = {
          ...baseItem(run, key, time),
          title: string(frame.title)?.trim() || null,
          status: "waiting" as const,
          completedAt: null,
          requestId,
        };
        const kind = method === "confirm" ? "permission" : "user_input";
        const item =
          kind === "permission"
            ? {
                ...base,
                type: "approval_request" as const,
                requestKind: "permission" as const,
                prompt: string(frame.message) ?? "",
                options: [
                  { decision: "accept" as const, label: "Approve" },
                  { decision: "decline" as const, label: "Decline" },
                ],
              }
            : { ...base, type: "user_input_request" as const, questions: validQuestions };
        const request: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId: base.nodeId,
          providerTurnId: run.turn.id,
          nativeRequestRef: nativeRef(nativeId),
          kind,
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt: time,
          resolvedAt: null,
        };
        dialogs.set(requestId, {
          run,
          key,
          method,
          nativeId,
          questions: validQuestions,
          item,
          request,
        });
        yield* publish(run, key, item);
        yield* emit({
          type: "runtime_request.updated",
          driver,
          threadId: run.input.threadId,
          runtimeRequest: request,
        });
        return;
      }
      if (!run) return;
      if (run.sideQuestion) {
        const side = run.sideQuestion;
        const reply = record(frame.record);
        if (frame.type === "btw_delta" && frame.recordId === side.recordId) {
          side.answer += string(frame.delta) ?? "";
          if (side.answer) yield* publishLocalText(run, "side-question", side.answer, true);
        } else if (frame.type === "btw_record") {
          const recordId = string(reply.id);
          if (!recordId || (side.recordId !== undefined && recordId !== side.recordId)) return;
          side.recordId = recordId;
          const latest = record(array(reply.followUps).at(-1) ?? reply);
          if (latest.status === "running") return;
          if (latest.status === "error") {
            run.status = "failed";
            run.error = string(latest.error) ?? "Oh My Pi could not answer the side question.";
          } else if (latest.status === "cancelled" || latest.status === "interrupted") {
            run.status = "interrupted";
          }
          const answer = string(latest.answer) || side.answer;
          if (answer) yield* publishLocalText(run, "side-question", answer);
          yield* finish(run);
        }
        return;
      }
      switch (frame.type) {
        case "todo_auto_clear":
          yield* publishTodos(run, []);
          return;
        case "response": {
          if (frame.id !== run.turn.id) return;
          if (frame.success === false) {
            run.status = "failed";
            run.error = string(frame.error) ?? "Oh My Pi rejected the request.";
          }
          yield* finish(run);
          return;
        }
        case "command_output": {
          const text = NodeUtil.stripVTControlCharacters(string(frame.text) ?? "");
          if (!text) return;
          const key = "command-output";
          const previous = run.rows.get(key);
          const time = yield* DateTime.now;
          yield* publish(run, key, {
            ...baseItem(run, key, time),
            type: "assistant_message",
            messageId: id.derive.messageFromProviderItem({
              driver,
              nativeItemId: `${run.turn.id}:${key}`,
            }),
            title: null,
            text: previous?.type === "assistant_message" ? `${previous.text}\n${text}` : text,
            streaming: false,
            status: "completed",
            completedAt: time,
          });
          return;
        }
        case "prompt_result":
          if (frame.id !== run.turn.id) return;
          run.awaitingPrompt = false;
          if (frame.status === "aborted") run.status = "interrupted";
          if (frame.status === "error" && run.status !== "interrupted") {
            run.status = "failed";
            run.error = string(record(frame.error).message) ?? "Oh My Pi rejected the prompt.";
          }
          if (frame.sessionSettled === true) yield* finish(run);
          return;
        case "session_settled":
          if (run.acknowledged && !run.awaitingPrompt) yield* finish(run);
          return;
        case "message_start":
        case "message_update":
        case "message_end": {
          const message = record(frame.message);
          if (message.role !== "assistant") return;
          if (frame.type === "message_start") run.messageIndex += 1;
          const streaming = frame.type !== "message_end";
          const time = yield* DateTime.now;
          for (const type of ["text", "thinking"] as const) {
            const text = contentText(message.content, type);
            const key = `${type}:${run.messageIndex}`;
            if (!text && !run.rows.has(key)) continue;
            const base = {
              ...baseItem(run, key, time),
              text,
              streaming,
              title: null,
              status: streaming ? ("running" as const) : ("completed" as const),
              completedAt: streaming ? null : time,
            };
            yield* publish(
              run,
              key,
              type === "thinking"
                ? { ...base, type: "reasoning" }
                : {
                    ...base,
                    type: "assistant_message",
                    messageId: id.derive.messageFromProviderItem({
                      driver,
                      nativeItemId: `${run.turn.id}:${key}`,
                    }),
                  },
            );
          }
          if (!streaming && message.usage !== undefined) run.lastMessageUsage = message.usage;
          if (!streaming && message.stopReason === "error" && run.status !== "interrupted") {
            run.status = "failed";
            run.error = string(message.errorMessage) ?? "Oh My Pi model failed.";
          }
          return;
        }
        case "tool_execution_start":
        case "tool_execution_update":
        case "tool_execution_end": {
          const toolId = string(frame.toolCallId);
          if (!toolId) return;
          const key = `tool:${toolId}`;
          const previous = run.rows.get(key);
          const args = frame.args ?? (previous?.type === "dynamic_tool" ? previous.input : null);
          const name = string(frame.toolName)?.trim() || null;
          const time = yield* DateTime.now;
          const ended = frame.type === "tool_execution_end";
          const base = {
            ...baseItem(run, key, time),
            title: name,
            completedAt: ended ? time : null,
            status: !ended
              ? ("running" as const)
              : frame.isError === true
                ? ("failed" as const)
                : ("completed" as const),
          };
          const output = ended ? frame.result : frame.partialResult;
          if (ended && name === "todo" && frame.isError !== true) {
            yield* publishTodos(run, record(record(output).details).phases);
          }
          yield* publish(run, key, {
            ...base,
            type: "dynamic_tool",
            toolName: name,
            input: args,
            ...(output === undefined
              ? {}
              : { output: contentText(record(output).content) || output }),
          });
          return;
        }
      }
    });
    yield* rpc.events.pipe(
      Stream.runForEach(onFrame),
      Effect.catch((error) =>
        Effect.gen(function* () {
          runtimeError = error;
          if (active) {
            active.status = "failed";
            active.error = error.message;
            yield* finish(active, true);
          } else yield* updateSession("error", error.message);
        }),
      ),
      Effect.forkScoped,
    );

    const resolvePrompt = Effect.fnUntraced(function* (args: {
      message: ProviderAdapterV2TurnInput["message"];
      appContext?: ProviderAdapterV2TurnInput["appContext"] | undefined;
    }) {
      if (/^\s*\/security(?:\s|$)/iu.test(args.message.text)) {
        return yield* unsupported("the native security workflow");
      }
      const text = yield* providerMessageTextWithAttachmentPaths({
        text: args.message.text,
        attachments: args.message.attachments,
        resolveAttachmentPath: host.resolveAttachmentPath,
        resolveExtractedTextPath: host.resolveExtractedTextPath,
      });
      const message = text.trimStart().startsWith("/")
        ? text
        : [...(args.appContext ?? []).map((entry) => entry.text), text]
            .filter(Boolean)
            .join("\n\n");
      const images: Array<{ type: "image"; mimeType: string; data: string }> = [];
      let totalImageBytes = 0;
      if (acceptsImages) {
        for (const attachment of args.message.attachments) {
          if (!isProviderNativeImageAttachment(attachment)) continue;
          const path = host.resolveAttachmentPath(attachment);
          if (path === null || attachment.sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) continue;
          const bytes = yield* fs.readFile(path).pipe(Effect.orElseSucceed(() => undefined));
          if (
            !bytes ||
            bytes.length === 0 ||
            bytes.length > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES ||
            totalImageBytes + bytes.length > 32 * 1024 * 1024
          )
            continue;
          totalImageBytes += bytes.length;
          images.push({
            type: "image",
            mimeType: attachment.mimeType,
            data: Buffer.from(bytes).toString("base64"),
          });
        }
      }
      return { message, ...(images.length === 0 ? {} : { images }) };
    });

    const runSubagentCommand = Effect.fnUntraced(function* (
      run: ActiveTurn,
      command: NonNullable<ReturnType<typeof readSubagentCommand>>,
      key: string,
      steering: boolean,
    ) {
      if (command.type === "invalid_subagent_command")
        return yield* ompProtocolError(
          "Enter a task ID and the arguments shown in the command menu.",
        );
      if (command.type === "steer_subagent") {
        if (!steering)
          return yield* ompProtocolError("Use Steer now while the subagent is running.");
        const task = subagents.get(command.subagentId);
        if (!task || task.providerThreadId !== thread?.id)
          return yield* ompProtocolError("This Oh My Pi subagent is no longer running.");
        yield* rpc.request(command);
        return;
      }
      const result = record(yield* rpc.request(command));
      if (active !== run) return;
      if (command.type === "get_subagents") {
        const rows = array(result.subagents)
          .slice(0, 50)
          .map(record)
          .map(
            (task) =>
              `- \`${string(task.id) ?? ""}\` · ${string(task.agent) ?? ""} · ${string(task.status) ?? ""}`,
          );
        yield* publishLocalText(run, key, rows.join("\n") || "No Oh My Pi subagents running.");
        return;
      }
      const messages = array(result.messages)
        .slice(-30)
        .map(record)
        .flatMap((message) => {
          if (message.role !== "user" && message.role !== "assistant") return [];
          const text = contentText(message.content).trim();
          return text ? [`**${message.role}**\n\n${text.slice(0, 3000)}`] : [];
        });
      const nextByte = typeof result.nextByte === "number" ? result.nextByte : command.fromByte;
      yield* publishLocalText(
        run,
        key,
        [
          `Oh My Pi subagent \`${command.subagentId}\`${result.reset === true ? " · Transcript restarted" : ""}`,
          messages.join("\n\n---\n\n") || "No user or assistant text in this transcript segment.",
          `Next byte offset: \`${nextByte}\``,
        ].join("\n\n"),
      );
    });

    const runSessionCommand = Effect.fnUntraced(function* (
      run: ActiveTurn,
      command: NonNullable<ReturnType<typeof readSessionCommand>>,
      key: string,
      steering: boolean,
      message?: ProviderAdapterV2SteerInput["message"],
    ) {
      const reply = (text: string) =>
        active === run ? publishLocalText(run, key, text) : Effect.void;
      switch (command.type) {
        case "invalid_session_command":
          return yield* ompProtocolError("Enter the arguments shown in the Oh My Pi command menu.");
        case "show_queue": {
          const queue = record((yield* getState()).queuedMessages);
          const steeringItems = array(queue.steering).filter(
            (item): item is string => typeof item === "string",
          );
          const liveSteered = typeof queue.liveSteered === "number" ? queue.liveSteered : 0;
          const format = (items: ReadonlyArray<unknown>) =>
            items
              .slice(0, 30)
              .map(
                (item) =>
                  `- ${NodeUtil.stripVTControlCharacters(string(item) ?? "").slice(0, 1000)}`,
              )
              .join("\n") || "Empty";
          yield* reply(
            `**Steering**\n\n${format(steeringItems.slice(liveSteered))}\n\n**Follow-up**\n\n${format(array(queue.followUp))}`,
          );
          break;
        }
        case "follow_up":
        case "remove_queued_message":
        case "promote_queued_message": {
          if (!steering)
            return yield* ompProtocolError(
              "Use Steer now while Oh My Pi is running to manage its native queue.",
            );
          if (
            command.type === "follow_up" &&
            ((yield* getState()).isStreaming !== true || active !== run)
          )
            return yield* ompProtocolError(
              "Oh My Pi has finished streaming. Send the follow-up as a new message.",
            );
          const request =
            command.type === "follow_up" && message?.attachments.length
              ? {
                  type: "follow_up",
                  ...(yield* resolvePrompt({ message: { ...message, text: command.message } })),
                }
              : command;
          const result = record(yield* rpc.request(request));
          yield* reply(
            command.type === "follow_up"
              ? "Queued in Oh My Pi."
              : command.type === "remove_queued_message"
                ? result.removed === true
                  ? "Removed from the Oh My Pi queue."
                  : "No matching queued message."
                : result.promoted === true
                  ? "Moved to the Oh My Pi steering queue."
                  : "No matching follow-up message.",
          );
          break;
        }
        case "abort_and_deliver_queue": {
          if (!steering)
            return yield* ompProtocolError("Use Steer now to deliver the native Oh My Pi queue.");
          const result = record(yield* rpc.request(command));
          yield* reply(
            result.aborted === true
              ? "Delivering the Oh My Pi queue."
              : "The Oh My Pi queue had nothing to deliver immediately.",
          );
          break;
        }
        case "show_todos":
        case "set_todos": {
          const result =
            command.type === "show_todos" ? yield* getState() : record(yield* rpc.request(command));
          if (active !== run) return;
          yield* publishTodos(run, result.todoPhases, true);
          if (array(result.todoPhases).length === 0)
            yield* reply("The Oh My Pi todo list is empty.");
          break;
        }
        case "set_steering_mode":
        case "set_follow_up_mode":
        case "set_interrupt_mode":
        case "set_cache_warming": {
          const result = record(yield* rpc.request(command));
          const mode = command.type === "set_cache_warming" ? string(result.mode) : command.mode;
          yield* reply(`Oh My Pi mode set to \`${mode ?? command.mode}\`.`);
          break;
        }
        case "set_fast_mode":
        case "set_slow_mode":
        case "set_auto_compaction":
        case "set_auto_retry": {
          const result = record(yield* rpc.request(command));
          const enabled = typeof result.enabled === "boolean" ? result.enabled : command.enabled;
          yield* reply(`Oh My Pi setting turned ${enabled ? "on" : "off"}.`);
          break;
        }
      }
    });

    const start = Effect.fnUntraced(function* (args: ProviderAdapterV2TurnInput, compact = false) {
      if (runtimeError) return yield* runtimeError;
      if (active) return yield* ompProtocolError("Oh My Pi is already running a turn");
      if (
        ompApprovalMode(args.runtimePolicy.runtimeMode) !== approvalMode ||
        args.runtimePolicy.interactionMode === "plan"
      ) {
        return yield* unsupported("this runtime policy");
      }
      const bound = yield* bind(args.providerThread);
      const goal = compact || args.resume ? null : parseGoalCommand(args.message);
      const localText = compact || args.resume ? "" : args.message.text;
      const sideCommand = readSideQuestionCommand(localText);
      const subagentCommand = readSubagentCommand(localText);
      const sessionCommand = readSessionCommand(localText);
      if ((sideCommand || subagentCommand || sessionCommand) && args.message.attachments.length > 0)
        return yield* ompProtocolError("This Oh My Pi command does not take attachments.");
      if (
        !subagentCommand &&
        !sessionCommand &&
        (goal === null || goal.type === "set" || goal.type === "resume")
      )
        yield* applySelection(args.modelSelection);
      const startedAt = yield* DateTime.now;
      const run: ActiveTurn = {
        input: args,
        turn: {
          id: id.derive.providerTurn({
            driver,
            nativeTurnId: `${input.providerSessionId}:${args.attemptId}`,
          }),
          providerThreadId: bound.id,
          nodeId: args.rootNodeId,
          runAttemptId: args.attemptId,
          nativeTurnRef: null,
          ordinal: args.providerTurnOrdinal,
          status: "running",
          startedAt,
          completedAt: null,
          ...(session.model === null ? {} : { model: session.model }),
        },
        done: yield* Deferred.make<void>(),
        rows: new Map(),
        messageIndex: 0,
        ...(sideCommand?.type === "btw"
          ? {
              sideQuestion: {
                recordId: "recordId" in sideCommand ? sideCommand.recordId : undefined,
                answer: "",
              },
            }
          : {}),
        awaitingPrompt:
          goal === null &&
          !compact &&
          !args.resume &&
          !sideCommand &&
          !subagentCommand &&
          !sessionCommand,
        acknowledged: false,
        status: "completed",
      };
      active = run;
      yield* emit({
        type: "provider_turn.updated",
        driver,
        threadId: args.threadId,
        providerTurn: run.turn,
      });
      yield* updateThread({
        status: "active",
        firstRunOrdinal: bound.firstRunOrdinal ?? args.runOrdinal,
        lastRunOrdinal: args.runOrdinal,
      });
      yield* updateSession("running");
      const submit = Effect.gen(function* () {
        if (sessionCommand) {
          yield* runSessionCommand(run, sessionCommand, "session-command", false);
          yield* finish(run);
          return;
        }
        if (subagentCommand) {
          yield* runSubagentCommand(run, subagentCommand, "subagents", false);
          yield* finish(run);
          return;
        }
        if (sideCommand?.type === "btw") {
          if (!sideCommand.question)
            return yield* ompProtocolError("Enter a side question after the command.");
          yield* rpc.request(sideCommand);
          return;
        }
        if (sideCommand?.type === "get_btw_history") {
          const result = record(yield* rpc.request(sideCommand));
          const history = array(result.records)
            .slice(0, 20)
            .map((value) => {
              const topic = record(value);
              const latest = record(array(topic.followUps).at(-1) ?? topic);
              return `${string(topic.id) ?? ""} · ${string(topic.question) ?? ""}\n\n${(string(latest.answer) ?? "").slice(0, 3000)}`;
            });
          yield* publishLocalText(
            run,
            "side-history",
            history.join("\n\n---\n\n") || "No Oh My Pi side questions yet.",
          );
          yield* finish(run);
          return;
        }
        yield* hostTools.refresh();
        if (goal !== null) {
          const result = record(yield* rpc.request(goalRequest(goal)));
          yield* updateThread({ goal: readGoal(result.goal) });
        } else if (compact) {
          const result = record(yield* rpc.request({ type: "compact" }));
          const time = yield* DateTime.now;
          yield* publish(run, "compact", {
            ...baseItem(run, "compact", time),
            type: "compaction",
            driver,
            title: null,
            status: "completed",
            completedAt: time,
            summary: string(result.summary) ?? "",
          });
        } else if (args.resume) {
          yield* rpc.request({ type: "resume" }, run.turn.id);
        } else {
          const prompt = yield* resolvePrompt(args);
          yield* rpc.request({ type: "prompt", ...prompt }, run.turn.id);
        }
        run.acknowledged = true;
        if (goal !== null || compact || args.resume) {
          if ((yield* getState()).isSettled !== false) yield* finish(run);
        }
      });
      yield* submit.pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            run.status = "failed";
            run.error = error.message;
            yield* finish(run, runtimeError !== undefined);
          }),
        ),
      );
    });

    const forkThread = Effect.fn("OmpAdapter.forkThread")(function* (
      request: ProviderAdapterV2ForkThreadInput,
    ) {
      if (active) return yield* ompProtocolError("Wait for Oh My Pi to finish before forking");
      const source = request.sourceProviderThread;
      const sourceFile = source.nativeThreadRef?.nativeId;
      if (
        !sourceFile ||
        source.driver !== driver ||
        source.providerInstanceId !== options.instanceId
      )
        return yield* ompProtocolError("The source Oh My Pi session is unavailable");
      const sourceTurn = request.sourceProviderTurns?.find(
        (turn) => turn.id === request.providerTurnId,
      );
      const at = sourceTurn?.nativeTurnRef?.nativeId;
      if (request.providerTurnId !== undefined && !at)
        return yield* ompProtocolError("This Oh My Pi turn has no saved conversation boundary");
      const forkedFile = yield* Effect.gen(function* () {
        const sourceRpc = yield* openOmpRpc({
          binaryPath: options.binaryPath,
          args: ["--mode", "rpc", "--no-extensions", "--no-tools", "--resume", sourceFile],
          cwd,
          environment: options.environment,
        });
        const sourceState = record(yield* sourceRpc.request({ type: "get_state" }));
        if (sourceState.sessionFile !== sourceFile)
          return yield* ompProtocolError("Oh My Pi did not open the fork source");
        let entryId: string | undefined;
        if (at) {
          const tree = record(yield* sourceRpc.request({ type: "get_entries" }));
          if (tree.leafId !== at) {
            const entries = new Map(
              array(tree.entries).map((value) => {
                const entry = record(value);
                return [string(entry.id), entry] as const;
              }),
            );
            let cursor: string | undefined = at;
            const visited = new Set<string>();
            while (cursor && !visited.has(cursor)) {
              visited.add(cursor);
              const entry = entries.get(cursor);
              if (entry?.type === "message") {
                entryId = cursor;
                break;
              }
              cursor = string(entry?.parentId);
            }
            if (!entryId)
              return yield* ompProtocolError("The saved Oh My Pi fork boundary was not found");
          }
        }
        const forked = record(
          yield* sourceRpc.request({ type: "fork", ...(entryId ? { entryId } : {}) }),
        );
        const state = record(yield* sourceRpc.request({ type: "get_state" }));
        const file = string(state.sessionFile);
        if (forked.cancelled === true || !file || file === sourceFile)
          return yield* ompProtocolError("Oh My Pi did not create a new session for the fork");
        return file;
      }).pipe(
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const now = yield* DateTime.now;
      return yield* bind({
        id: id.derive.providerThread({
          driver,
          nativeThreadId: `${options.instanceId}:${forkedFile}`,
        }),
        driver,
        providerInstanceId: options.instanceId,
        providerSessionId: input.providerSessionId,
        appThreadId: request.targetThreadId,
        ownerNodeId: request.ownerNodeId ?? null,
        nativeThreadRef: nativeRef(forkedFile),
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: {
          providerThreadId: source.id,
          ...(request.providerTurnId ? { providerTurnId: request.providerTurnId } : {}),
        },
        createdAt: now,
        updatedAt: now,
      });
    });
    const readThreadSnapshot = Effect.fn("OmpAdapter.readThreadSnapshot")(function* ({
      providerThread,
    }: ProviderAdapterV2ReadThreadSnapshotInput) {
      const bound = yield* bind(providerThread);
      const result = record(yield* rpc.request({ type: "get_messages" }));
      const messages: OrchestrationV2ConversationMessage[] = [];
      const time = yield* DateTime.now;
      for (const [index, value] of array(result.messages).entries()) {
        const message = record(value);
        const role = message.role;
        if (role !== "user" && role !== "assistant") continue;
        const text = contentText(message.content);
        if (!text) continue;
        const identity = { driver, nativeItemId: `${bound.id}:snapshot:${index}` };
        const createdAt =
          typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
            ? DateTime.makeUnsafe(message.timestamp)
            : time;
        messages.push({
          id: id.derive.messageFromProviderItem(identity),
          threadId: input.threadId,
          runId: null,
          nodeId: id.derive.nodeFromProviderItem(identity),
          role,
          text,
          attachments: [],
          streaming: false,
          createdBy: role === "user" ? "user" : "agent",
          creationSource: "provider",
          createdAt,
          updatedAt: createdAt,
        });
      }
      return {
        providerThread: bound,
        messages,
        runtimeRequests: [...dialogs.values()].map(({ request }) => request),
      };
    });

    return {
      instanceId: options.instanceId,
      driver,
      providerSessionId: input.providerSessionId,
      get providerSession() {
        return session;
      },
      events: Stream.fromQueue(events),
      ensureThread: (request) => bind(request.existingProviderThread, request.forceNewNativeThread),
      resumeThread: (request) => bind(request.providerThread),
      startTurn: (args) => start(args),
      resumeTurn: (args) => start(resumeTurnInput(args)),
      compactThread: (args) => start(args, true),
      steerTurn: Effect.fn("OmpAdapter.steerTurn")(function* (args: ProviderAdapterV2SteerInput) {
        const run = active;
        if (!run || run.turn.id !== args.providerTurnId)
          return yield* ompProtocolError("This Oh My Pi turn is no longer active");
        if (run.sideQuestion || readSideQuestionCommand(args.message.text)) {
          return yield* ompProtocolError("Queue the message to send it after this Oh My Pi turn.");
        }
        const subagentCommand = readSubagentCommand(args.message.text);
        const sessionCommand = readSessionCommand(args.message.text);
        if (subagentCommand || sessionCommand) {
          if (args.message.attachments.length > 0 && sessionCommand?.type !== "follow_up")
            return yield* ompProtocolError("This Oh My Pi command does not take attachments.");
          const key = `omp-command:${args.message.messageId}`;
          if (subagentCommand) yield* runSubagentCommand(run, subagentCommand, key, true);
          if (sessionCommand)
            yield* runSessionCommand(run, sessionCommand, key, true, args.message);
          return;
        }
        const prompt = yield* resolvePrompt(args);
        if (active !== run)
          return yield* ompProtocolError("This Oh My Pi turn is no longer active");
        yield* rpc.request({ type: "steer", ...prompt });
      }),
      stopSubagent: Effect.fn("OmpAdapter.stopSubagent")(function* ({
        providerThread,
        nativeTaskId,
        requestedAt,
      }) {
        const task = subagents.get(nativeTaskId);
        if (
          !task ||
          task.providerThreadId !== providerThread.id ||
          (requestedAt &&
            task.startedAt &&
            DateTime.toEpochMillis(requestedAt) < DateTime.toEpochMillis(task.startedAt))
        )
          return;
        const result = record(
          yield* rpc.request({ type: "cancel_subagent", subagentId: nativeTaskId }),
        );
        if (result.cancelled !== true && subagents.get(nativeTaskId)?.status === "running")
          return yield* ompProtocolError("Oh My Pi could not confirm the subagent stopped");
        if (result.cancelled === true)
          return { status: "cancelled" as const, completedAt: yield* DateTime.now, result: null };
      }),
      interruptTurn: Effect.fnUntraced(function* ({ providerTurnId }) {
        const run = active;
        if (!run || run.turn.id !== providerTurnId || run.recoveringQueue) return;
        run.status = "interrupted";
        if (run.sideQuestion) {
          yield* rpc.request({ type: "btw_cancel", recordId: run.sideQuestion.recordId });
          yield* finish(run);
          return;
        }
        run.recoveringQueue = true;
        yield* Effect.gen(function* () {
          const raw = yield* rpc.request({ type: "abort_and_restore_queue" });
          const recovered = readOmpQueueRecovery(raw);
          let imagesDropped = recovered.imagesDropped;
          const entries = yield* Effect.forEach(recovered.entries, (entry) =>
            Effect.gen(function* () {
              const attachments = yield* Effect.forEach(
                entry.images,
                (image) =>
                  host.saveRecoveredImage?.({ ...image, threadId: run.input.threadId }) ??
                  Effect.undefined,
              );
              if (attachments.some((image) => image === undefined)) imagesDropped = true;
              return {
                text: entry.text,
                attachments: attachments.filter((image) => image !== undefined),
              };
            }),
          );
          if (entries.length === 0 && !recovered.truncated && !imagesDropped) return;
          const at = yield* DateTime.now;
          yield* publish(run, "queue-recovery", {
            ...baseItem(run, "queue-recovery", at),
            type: "system_notice",
            title: null,
            message: "Oh My Pi queue recovered",
            status: "completed",
            completedAt: at,
            recoveredQueue: { entries, imagesDropped, truncated: recovered.truncated },
          });
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              run.recoveringQueue = false;
              const deferred = run.postponedFinish;
              if (deferred) yield* finish(run, deferred.broken);
            }),
          ),
        );
        if (active === run && (yield* getState()).isSettled === true) yield* finish(run);
      }),
      applyThreadTitle: ({ title }) =>
        rpc.request({ type: "set_session_name", name: title }).pipe(Effect.asVoid),
      readThreadSnapshot,
      respondToPrivateInput: Effect.fnUntraced(function* ({ itemId, values }) {
        const dialog = privateDialogs.get(itemId);
        if (!dialog || active !== dialog.run) {
          return yield* ompProtocolError("This Oh My Pi request is no longer active");
        }
        const response = values === undefined ? { cancelled: true } : dialog.response(values);
        if (!response) return yield* ompProtocolError("Invalid Oh My Pi form answer");
        yield* rpc
          .send({ type: "extension_ui_response", id: dialog.nativeId, ...response })
          .pipe(Effect.mapError(() => ompProtocolError("Oh My Pi could not receive the answer")));
        yield* settlePrivateDialog(itemId, values === undefined ? "declined" : "saved");
      }),
      respondToRuntimeRequest: Effect.fn("OmpAdapter.respondToRuntimeRequest")(function* ({
        requestId,
        answers,
        decision,
      }) {
        const dialog = dialogs.get(requestId);
        if (!dialog) return yield* ompProtocolError("This Oh My Pi request is no longer active");
        const response =
          dialog.method === "confirm"
            ? decision === "accept" || decision === "decline"
              ? { confirmed: decision === "accept" }
              : undefined
            : dialogAnswer(dialog.method, dialog.questions, answers);
        yield* rpc.send({
          type: "extension_ui_response",
          id: dialog.nativeId,
          ...(response ?? { cancelled: true }),
        });
        yield* settleDialog(requestId, response ? "resolved" : "cancelled");
      }),
      rollbackThread: Effect.fn("OmpAdapter.rollbackThread")(function* ({
        providerThread,
        target,
      }: ProviderAdapterV2RollbackThreadInput) {
        if (active)
          return yield* ompProtocolError("Wait for Oh My Pi to finish before rolling back");
        if (target.type === "thread_start") {
          const bound = yield* bind(providerThread, true);
          return yield* readThreadSnapshot({ providerThread: bound });
        }
        const head = target.providerTurn.nativeTurnRef;
        if (head?.driver !== driver)
          return yield* ompProtocolError(
            "The Oh My Pi checkpoint has no saved conversation boundary",
          );
        yield* bind(providerThread);
        const moved = record(
          yield* rpc.request({ type: "navigate_tree", entryId: head.nativeId, summarize: false }),
        );
        if (moved.cancelled === true || (yield* readConversationHead()) !== head.nativeId)
          return yield* ompProtocolError(
            "Oh My Pi did not restore the saved conversation boundary",
          );
        const goal = record(yield* rpc.request({ type: "goal", op: "get" }));
        yield* updateThread({ nativeConversationHeadRef: head, goal: readGoal(goal.goal) });
        return yield* readThreadSnapshot({ providerThread });
      }),
      forkThread,
    } satisfies ProviderAdapterV2SessionRuntime;
  });
  return {
    instanceId: options.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(ompCapabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession,
  } satisfies ProviderAdapterV2["Service"];
});
