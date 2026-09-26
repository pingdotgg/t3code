// @effect-diagnostics nodeBuiltinImport:off - opaque command and stream identities are minted at the adapter boundary.
import * as NodeCrypto from "node:crypto";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  CommandId,
  ExtensionOperationError,
  OrchestrationCommand,
  ThreadId,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { foldSubagentActivities } from "@t3tools/client-runtime/state/subagentRuntime";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import {
  ORCHESTRATION_STATUS_API,
  ORCHESTRATION_CONTROL_API,
  type AgentsState,
  type OrchestrationReceipt,
} from "@t3tools/extension-sdk/catalogue";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type { HostApiProvider, HostApiInvocationMetadata } from "@t3tools/extension-runtime";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointDiffQuery } from "../../checkpointing/CheckpointDiffQuery.ts";
import { readWorkflowScript } from "../../orchestration/workflowScriptQuery.ts";
import { makeExtensionScopeResolver } from "../scope.ts";
import { boundedPrefix, streamDiffPreview } from "../vcsDiffApi.ts";

const fail = (detail: string) =>
  new ExtensionOperationError({ operation: "orchestration", detail });
const isOperationError = Schema.is(ExtensionOperationError);
const decode = Schema.decodeUnknownSync(OrchestrationCommand, { onExcessProperty: "error" });
const json = Schema.decodeUnknownSync(Schema.Json);
const decodeCommandId = Schema.decodeUnknownSync(CommandId);
const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));
const empty = Schema.decodeUnknownSync(Schema.Struct({}), { onExcessProperty: "error" });
const workflowInput = Schema.decodeUnknownSync(Schema.Struct({ workflowId: Schema.String }), {
  onExcessProperty: "error",
});
const turnDiffInput = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({ turnId: Schema.String }),
    Schema.Struct({ turnCount: Schema.Int.check(Schema.isGreaterThan(0)) }),
  ]),
  { onExcessProperty: "error" },
);
const queueCap = 64;
const queueBytesCap = 1024 * 1024;
const frameBytesCap = 60 * 1024;
/** The contract caps getWorkflowScript contents at 8 192 units. */
const workflowScriptUnitsCap = 8_192;
const nativeTypes = {
  "turn.start": "thread.turn.start",
  "turn.interrupt": "thread.turn.interrupt",
  "session.stop": "thread.session.stop",
  "approval.respond": "thread.approval.respond",
  "userInput.respond": "thread.user-input.respond",
  "userInput.dismiss": "thread.user-input.dismiss",
  "thread.settle": "thread.settle",
  "thread.unsettle": "thread.unsettle",
  "checkpoint.revert": "thread.checkpoint.revert",
} as const;
type ControlOp = keyof typeof nativeTypes;
const isControlOp = (name: string): name is ControlOp => Object.hasOwn(nativeTypes, name);

type Serialized<T> = T extends string | number | boolean | null
  ? T
  : T extends readonly (infer U)[]
    ? readonly Serialized<U>[]
    : T extends object
      ? { [K in keyof T]: Serialized<Exclude<T[K], undefined>> }
      : T;
/** JSON removes optional undefined fields from native Schema read models. */
function serialize<T>(value: T): Serialized<T> {
  return JSON.parse(JSON.stringify(value)) as Serialized<T>;
}

/** Both clients and this adapter run these exact folds; activities never enter the public object. */
export function projectAgents(
  snapshot: OrchestrationThreadDetailSnapshot,
  receipts: readonly OrchestrationReceipt[] = [],
): AgentsState {
  const thread = snapshot.thread;
  const pending = derivePendingRequests(thread.activities);
  return serialize({
    agents: foldSubagentActivities(thread.activities, {
      sessionLive:
        thread.session !== null &&
        !["stopped", "interrupted", "error"].includes(thread.session.status),
    }).slice(-100),
    pendingApprovals: pending.approvals,
    pendingUserInputs: pending.userInputs,
    checkpoints: thread.checkpoints,
    session: thread.session,
    turn: thread.latestTurn,
    receipts,
    retention: { agentsCap: 100 as const, receiptsCap: 100 as const },
  });
}

type Dependencies = Parameters<typeof makeExtensionScopeResolver>[0] & {
  readonly engine: Pick<
    OrchestrationEngineService["Service"],
    "dispatch" | "subscribeDomainEvents"
  >;
  readonly snapshots: Pick<ProjectionSnapshotQuery["Service"], "getThreadDetailSnapshot">;
  readonly receipts: Pick<OrchestrationCommandReceiptRepository["Service"], "getByCommandId">;
  readonly providers: {
    readonly getCapabilities: ProviderService["Service"]["getCapabilities"];
    readonly getInstanceInfo: (
      id: Parameters<ProviderService["Service"]["getInstanceInfo"]>[0],
    ) => Effect.Effect<
      Pick<
        Effect.Success<ReturnType<ProviderService["Service"]["getInstanceInfo"]>>,
        "enabled" | "driverKind"
      >,
      Effect.Error<ReturnType<ProviderService["Service"]["getInstanceInfo"]>>
    >;
  };
  readonly diffs: CheckpointDiffQuery["Service"];
  readonly readScript: typeof readWorkflowScript;
};

export function createOrchestrationApiProviders(deps: Dependencies): readonly HostApiProvider[] {
  const resolve = makeExtensionScopeResolver(deps);
  const epoch = NodeCrypto.randomUUID();
  // Recent receipts include rejected commands, which have no native domain event.
  // Durable idempotency is always read from the native repository, never this cache.
  const recent = new Map<string, { threadId: string; receipt: OrchestrationReceipt }>();
  const listeners = new Set<(threadId: string, receipt: OrchestrationReceipt) => void>();
  const pendingCommands = new Map<
    string,
    { threadId: string; promise: Promise<OrchestrationReceipt> }
  >();
  const remember = (threadId: string, receipt: OrchestrationReceipt) => {
    recent.delete(receipt.commandId);
    recent.set(receipt.commandId, { threadId, receipt });
    while (recent.size > 100) recent.delete(recent.keys().next().value!);
    for (const listener of listeners) listener(threadId, receipt);
    return receipt;
  };
  const snapshot = Effect.fn("OrchestrationApi.snapshot")(function* (threadId: string) {
    const found = yield* deps.snapshots.getThreadDetailSnapshot(ThreadId.make(threadId));
    if (Option.isNone(found) || found.value.thread.deletedAt !== null)
      return yield* fail("OrchestrationThreadUnavailable");
    return found.value;
  });
  const guard = async (
    context: ViewContext,
    signal: AbortSignal,
    metadata: HostApiInvocationMetadata,
    operate = false,
  ) => {
    signal.throwIfAborted();
    const scope = operate ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope;
    if (
      metadata.principal?.environmentId !== deps.environmentId ||
      !metadata.principal.scopes.includes(scope)
    )
      throw fail(`OrchestrationAuthorityDenied: ${scope}`);
    if (!context.resource.threadId) throw fail("OrchestrationThreadScopeRequired");
    await Effect.runPromise(resolve(context), { signal });
    // assertAuthority runs the broker's scope revalidation; its tagged
    // ExtensionOperationError (e.g. a stale workspace revision captured at
    // failure time) propagates through the dispatch boundary unchanged.
    await metadata.assertAuthority?.();
  };
  const capabilities = Effect.fn("OrchestrationApi.capabilities")(function* (
    state: OrchestrationThreadDetailSnapshot,
  ) {
    const instanceId =
      state.thread.session?.providerInstanceId ?? state.thread.modelSelection.instanceId;
    const probe = yield* Effect.gen(function* () {
      const info = yield* deps.providers.getInstanceInfo(instanceId);
      const adapter = yield* deps.providers.getCapabilities(instanceId);
      return { info, adapter };
    }).pipe(Effect.option);
    const available = Option.isSome(probe) && probe.value.info.enabled;
    const known =
      available &&
      ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"].includes(
        probe.value.info.driverKind,
      );
    return {
      streamEpoch: epoch,
      revision: state.snapshotSequence,
      operations: {
        getCapabilities: true,
        subscribeAgents: true,
        getTurnDiff: true,
        getThreadDiff: true,
        getWorkflowScript: projectAgents(state).agents.some(
          (agent) => agent.kind === "workflow" && agent.runHandles?.scriptPath !== undefined,
        ),
        "turn.start": known,
        "turn.interrupt": known,
        "session.stop": known,
        "approval.respond": known,
        "userInput.respond": known,
        "userInput.dismiss": known,
        "thread.settle": true,
        "thread.unsettle": true,
        "checkpoint.revert":
          known &&
          !["grok", "antigravity"].includes(probe.value.info.driverKind) &&
          probe.value.adapter.supportsConversationRollback !== false,
      },
    };
  });
  const control: HostApiProvider = {
    providerId: "t3.host-orchestration-control",
    definition: ORCHESTRATION_CONTROL_API,
    requiresRootAuthority: true,
    async invoke(method, input, context, signal, metadata) {
      await guard(context, signal, metadata, true);
      if (!isControlOp(method)) throw fail(`OrchestrationUnsupported: ${method}`);
      const safe = record(input);
      const commandId =
        safe.commandId === undefined ? NodeCrypto.randomUUID() : decodeCommandId(safe.commandId);
      const threadId = context.resource.threadId!;
      const cached = pendingCommands.get(commandId);
      if (cached) {
        if (cached.threadId !== threadId) throw fail("OrchestrationCommandConflict");
        return json(await cached.promise);
      }
      const execute = Effect.fn("OrchestrationApi.control")(function* () {
        const saved = yield* deps.receipts.getByCommandId({ commandId: CommandId.make(commandId) });
        if (Option.isSome(saved)) {
          if (saved.value.aggregateKind !== "thread" || saved.value.aggregateId !== threadId)
            return yield* fail("OrchestrationCommandConflict");
          return remember(threadId, {
            commandId,
            status: saved.value.status,
            sequence: saved.value.resultSequence,
            error: saved.value.status === "rejected" ? "OrchestrationCommandRejected" : null,
          });
        }
        const state = yield* snapshot(threadId);
        const reject = (error: string): OrchestrationReceipt =>
          remember(threadId, {
            commandId,
            status: "rejected",
            sequence: state.snapshotSequence,
            error,
          });
        if (safe.expectedEpoch !== undefined && safe.expectedEpoch !== epoch)
          return reject("OrchestrationWrongEpoch");
        if (safe.expectedRevision !== undefined && safe.expectedRevision !== state.snapshotSequence)
          return reject("OrchestrationStaleRevision");
        const support = yield* capabilities(state);
        if (!support.operations[method]) return reject(`OrchestrationUnsupported: ${method}`);
        for (const name of [
          "attachments",
          "bootstrap",
          "sourceProposedPlan",
          "attachmentsByQuestionId",
        ]) {
          if (Object.hasOwn(safe, name)) return reject(`OrchestrationUnsupported: ${name}`);
        }
        const {
          commandId: _id,
          expectedEpoch: _epoch,
          expectedRevision: _revision,
          ...args
        } = safe;
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const command = yield* Effect.try({
          try: () => {
            const base = { ...args, type: nativeTypes[method], commandId, threadId };
            if (method === "turn.start") {
              const { text, ...rest } = args;
              return decode({
                ...rest,
                type: nativeTypes[method],
                commandId,
                threadId,
                runtimeMode: args.runtimeMode ?? state.thread.runtimeMode,
                interactionMode: args.interactionMode ?? state.thread.interactionMode,
                message: { messageId: commandId, role: "user", text, attachments: [] },
                createdAt,
              });
            }
            if (method === "thread.settle") return decode(base);
            if (method === "thread.unsettle") return decode({ ...base, reason: "user" });
            return decode({ ...base, createdAt });
          },
          catch: () => fail("OrchestrationInvalidInput"),
        }).pipe(Effect.option);
        if (Option.isNone(command)) return reject("OrchestrationInvalidInput");
        yield* Effect.tryPromise({
          try: () => guard(context, signal, metadata, true),
          // Guard failures already carry their honest name — a stale
          // workspace revision is not an authority denial. Wrap only the
          // foreign throws (revocation hooks, aborts).
          catch: (cause) =>
            isOperationError(cause) ? cause : fail("OrchestrationAuthorityDenied"),
        });
        const result = yield* deps.engine.dispatch(command.value).pipe(
          Effect.map((value) => ({
            commandId,
            status: "accepted" as const,
            sequence: value.sequence,
            error: null,
          })),
          Effect.catch(() =>
            Effect.succeed({
              commandId,
              status: "rejected" as const,
              sequence: state.snapshotSequence,
              error: "OrchestrationCommandRejected",
            }),
          ),
        );
        return remember(threadId, result);
      });
      const promise = Effect.runPromise(execute(), { signal });
      pendingCommands.set(commandId, { threadId, promise });
      try {
        return json(await promise);
      } finally {
        pendingCommands.delete(commandId);
      }
    },
  };

  const status: HostApiProvider = {
    providerId: "t3.host-orchestration-status",
    definition: ORCHESTRATION_STATUS_API,
    requiresRootAuthority: true,
    async invoke(method, input, context, signal, metadata) {
      await guard(context, signal, metadata);
      const state = await Effect.runPromise(snapshot(context.resource.threadId!), { signal });
      if (method === "getCapabilities") {
        empty(input);
        return json(await Effect.runPromise(capabilities(state), { signal }));
      }
      if (method !== "getWorkflowScript") throw fail(`OrchestrationUnsupported: ${method}`);
      const safe = workflowInput(input);
      const workflow = projectAgents(state).agents.find(
        (agent) => agent.id === safe.workflowId && agent.kind === "workflow",
      );
      if (!workflow?.runHandles?.scriptPath)
        throw fail("OrchestrationUnsupported: getWorkflowScript");
      const script = await Effect.runPromise(
        deps.readScript({ scriptPath: workflow.runHandles.scriptPath }),
        { signal },
      );
      await guard(context, signal, metadata);
      const contents = boundedPrefix(script.contents, workflowScriptUnitsCap);
      return {
        contents,
        truncated: script.truncated || contents.length < script.contents.length,
      };
    },
    subscribe(name, input, context, signal, metadata, cursor) {
      if (cursor !== undefined)
        throw fail("OrchestrationUnsupported: resumeCursor; resubscribe for a snapshot");
      if (name === "getTurnDiff" || name === "getThreadDiff")
        return (async function* () {
          await guard(context, signal, metadata);
          const state = await Effect.runPromise(snapshot(context.resource.threadId!), { signal });
          let count: number;
          if (name === "getTurnDiff") {
            const safe = turnDiffInput(input);
            const checkpoint = state.thread.checkpoints.find((item) =>
              "turnId" in safe
                ? item.turnId === safe.turnId
                : item.checkpointTurnCount === safe.turnCount,
            );
            if (!checkpoint || checkpoint.checkpointTurnCount < 1)
              throw fail("OrchestrationCheckpointUnavailable");
            count = checkpoint.checkpointTurnCount;
          } else {
            empty(input);
            count = Math.max(
              0,
              ...state.thread.checkpoints.map((item) => item.checkpointTurnCount),
            );
          }
          const diff = await Effect.runPromise(
            name === "getTurnDiff"
              ? deps.diffs.getTurnDiff({
                  threadId: state.thread.id,
                  fromTurnCount: count - 1,
                  toTurnCount: count,
                })
              : deps.diffs.getFullThreadDiff({ threadId: state.thread.id, toTurnCount: count }),
            { signal },
          );
          const now = await Effect.runPromise(DateTime.now);
          yield* streamDiffPreview({
            generatedAt: DateTime.formatIso(now),
            guard: () => guard(context, signal, metadata),
            sources: [
              {
                id: `checkpoint-${diff.fromTurnCount}-${diff.toTurnCount}`,
                kind: "branch-range",
                title: name === "getTurnDiff" ? "Turn changes" : "Thread changes",
                baseRef: null,
                headRef: null,
                diff: diff.diff,
                diffHash: "",
                truncated: false,
              },
            ],
          });
        })();
      if (name !== "subscribeAgents") throw fail(`OrchestrationUnsupported: ${name}`);
      empty(input);
      return agentsStream(context, signal, metadata);
    },
  };

  function agentsStream(
    context: ViewContext,
    signal: AbortSignal,
    metadata: HostApiInvocationMetadata,
  ): AsyncIterable<ApiStreamEvent> {
    const controller = new AbortController();
    const runSignal = AbortSignal.any([signal, controller.signal]);
    const queue: { event: ApiStreamEvent; bytes: number }[] = [];
    let bytes = 0;
    let wake: (() => void) | undefined;
    let ended = false;
    let failure: unknown;
    let revision = -1;
    let nativeOverflow = false;
    let started = false;
    let producer: Promise<void> | undefined;
    const threadId = context.resource.threadId!;
    const wakeUp = () => {
      wake?.();
      wake = undefined;
    };
    const close = () => {
      ended = true;
      controller.abort();
      wakeUp();
    };
    const offer = (event: ApiStreamEvent) => {
      if (ended) return;
      const size = Buffer.byteLength(JSON.stringify(event));
      if (size > frameBytesCap) throw fail("OrchestrationProjectionTooLarge");
      if (queue.length >= queueCap || bytes + size > queueBytesCap) {
        const initial = queue[0]?.event.type === "snapshot" ? queue[0] : undefined;
        queue.length = 0;
        bytes = initial?.bytes ?? 0;
        if (initial) queue.push(initial);
        queue.push({
          event: {
            type: "closed",
            value: { kind: "closed", streamEpoch: epoch, reason: "overflow" },
          },
          bytes: 0,
        });
        close();
      } else {
        queue.push({ event, bytes: size });
        bytes += size;
        wakeUp();
      }
    };
    const receiptListener = (id: string, receipt: OrchestrationReceipt) => {
      if (id === threadId && revision >= 0)
        offer({ type: "data", value: { kind: "receipt", streamEpoch: epoch, revision, receipt } });
    };
    const publish = (state: OrchestrationThreadDetailSnapshot, initial: boolean) => {
      if (!initial && state.snapshotSequence <= revision) return;
      revision = state.snapshotSequence;
      const receipts = [...recent.values()]
        .filter((item) => item.threadId === threadId)
        .map((item) => item.receipt);
      const projected = projectAgents(state, receipts);
      // The wire schema caps phases at 100 items and the fold never bounds
      // them; a pathological roster must fail by name, not as a broker
      // schema rejection.
      for (const agent of projected.agents) {
        if (agent.phases.length > 100) throw fail("OrchestrationProjectionTooLarge");
      }
      offer({
        type: initial ? "snapshot" : "data",
        value: json({
          kind: initial ? "snapshot" : "updated",
          streamEpoch: epoch,
          revision,
          ...projected,
        }),
      });
    };
    const abort = () => {
      queue.length = 0;
      bytes = 0;
      close();
    };
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      listeners.delete(receiptListener);
      signal.removeEventListener("abort", abort);
    };
    const start = () => {
      if (started) return;
      started = true;
      producer = (async () => {
        try {
          await guard(context, runSignal, metadata);
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                // Acquire the live subscription before the transactional snapshot read.
                const events = yield* deps.engine.subscribeDomainEvents;
                const updates = yield* Queue.dropping<number>(queueCap);
                yield* Effect.forkScoped(
                  events.pipe(
                    Stream.filter(
                      (event) =>
                        event.aggregateKind === "thread" &&
                        event.aggregateId === threadId &&
                        event.type !== "thread.message-sent",
                    ),
                    Stream.runForEach(
                      Effect.fn("OrchestrationApi.invalidate")(function* (event) {
                        if (!(yield* Queue.offer(updates, event.sequence))) {
                          nativeOverflow = true;
                          if (revision >= 0) {
                            offer({
                              type: "closed",
                              value: { kind: "closed", streamEpoch: epoch, reason: "overflow" },
                            });
                            close();
                          }
                        }
                      }),
                    ),
                  ),
                  { startImmediately: true },
                );
                listeners.add(receiptListener);
                publish(yield* snapshot(threadId), true);
                if (nativeOverflow) {
                  offer({
                    type: "closed",
                    value: { kind: "closed", streamEpoch: epoch, reason: "overflow" },
                  });
                  close();
                }
                yield* Stream.fromQueue(updates).pipe(
                  Stream.runForEach(
                    Effect.fn("OrchestrationApi.update")(function* (sequence) {
                      if (sequence <= revision) return;
                      publish(yield* snapshot(threadId), false);
                    }),
                  ),
                );
              }),
            ),
            { signal: runSignal },
          );
        } catch (error) {
          if (!ended) failure = error;
        } finally {
          ended = true;
          cleanup();
          wakeUp();
        }
      })();
    };
    return {
      [Symbol.asyncIterator]() {
        let returned = false;
        return {
          async next() {
            if (returned) return { done: true as const, value: undefined };
            start();
            // Receipt callbacks and the producer wake this waiter; no polling.
            // eslint-disable-next-line no-unmodified-loop-condition -- producer and receipt callbacks wake this waiter.
            while (queue.length === 0 && !ended)
              await new Promise<void>((resolveWait) => {
                wake = resolveWait;
              });
            signal.throwIfAborted();
            if (failure) throw failure;
            const next = queue.shift();
            if (!next) return { done: true as const, value: undefined };
            bytes -= next.bytes;
            try {
              await guard(context, signal, metadata);
            } catch (error) {
              close();
              cleanup();
              throw error;
            }
            return { done: false as const, value: next.event };
          },
          async return() {
            returned = true;
            queue.length = 0;
            bytes = 0;
            close();
            cleanup();
            await producer;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
  }
  return [status, control];
}

export const makeOrchestrationApiProviders = Effect.fn("OrchestrationApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  return createOrchestrationApiProviders({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    engine: yield* OrchestrationEngineService,
    snapshots: yield* ProjectionSnapshotQuery,
    receipts: yield* OrchestrationCommandReceiptRepository,
    providers: yield* ProviderService,
    diffs: yield* CheckpointDiffQuery,
    readScript: readWorkflowScript,
  });
});
