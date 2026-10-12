/**
 * Offers pending provider approvals to the enabled plugins that declare the
 * `approvals` capability, and records the first answer through the
 * orchestrator.
 *
 * It watches committed runtime requests and approval cards. Once a pending,
 * live approval of a kind some plugin declares and its card, with the prompt,
 * are both committed, it calls each such plugin's `t3.approval.decide` handler
 * at once, each with its own deadline. Providers commit the two in either
 * order; a request whose card never arrives, or has no prompt, is left to the
 * user. An approve
 * or deny becomes a `runtime-request.plugin-respond` command, which the
 * orchestrator accepts only while the request is still pending, so the first
 * answer recorded wins, whether it came from the user or a plugin. Abstaining,
 * an invalid answer, a failure, the deadline, and disabling the plugin all
 * leave the request to the user. When the request stops being pending, calls
 * still running are cancelled.
 *
 * Plugins decide on the whole request or not at all: when its prompt or subject
 * is longer than a plugin may receive, no plugin is asked. Work is bounded: at
 * most `maxActiveOffers` requests are being offered and `maxActiveCalls` plugin
 * calls are running at once; past either limit the request, or that plugin's
 * call, is left to the user at once rather than queued.
 *
 * Only requests committed while this service runs are offered: after a
 * restart, an older pending request waits for the user. Plugin work never runs
 * on EventSink's commit path; the subscription is bounded and resumes from the
 * last event it saw when it falls behind.
 */
import {
  CommandId,
  PLUGIN_APPROVAL_HANDLER,
  PLUGIN_APPROVAL_LIMITS,
  PLUGIN_APPROVALS_CAPABILITY,
  PluginApprovalAnswer,
  PluginApprovalKind,
  PluginApprovalRequest,
  type EnvironmentId,
  type NodeId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2TurnItem,
  type PluginCatalogError,
  type PluginInstallation,
  type PluginInstallationId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { EventSinkV2, type EventSinkV2Error } from "../orchestration-v2/EventSink.ts";
import { LiveStreamBufferError } from "../orchestration-v2/LiveStreamBudget.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  ProjectionStoreV2,
  type ProjectionRuntimeResponseContext,
} from "../orchestration-v2/ProjectionStore.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import { PluginCatalog } from "./PluginCatalog.ts";
import type { PluginInvokeError } from "./PluginSupervisor.ts";

/** Why a plugin's call left the request to the user. */
type PluginApprovalAbstainCause =
  /** The plugin answered `abstain` or `null`. */
  | "abstained"
  /** The answer did not match `PluginApprovalAnswer`. */
  | "invalid"
  | "deadline"
  /** Disabled, removed, re-registered, stopped, busy, or otherwise not callable. */
  | "unavailable"
  /** `maxActiveCalls` plugin calls were already running; this one was not started. */
  | "overloaded"
  /** The handler threw, the process crashed, or the result was too large. */
  | "failed"
  /** The request stopped being pending (answered, cancelled, or no longer answerable) first. */
  | "withdrawn";

/** Progress of one plugin's call for one request, in order. Tests wait on these. */
export type PluginApprovalReceipt =
  | {
      readonly _tag: "Asked";
      readonly requestId: RuntimeRequestId;
      readonly installationId: PluginInstallationId;
    }
  | {
      readonly _tag: "Abstained";
      readonly requestId: RuntimeRequestId;
      readonly installationId: PluginInstallationId;
      readonly cause: PluginApprovalAbstainCause;
      readonly message?: string;
    }
  /**
   * The plugin's answer was recorded and its provider response queued. The
   * response worker delivers it to the provider afterwards.
   */
  | {
      readonly _tag: "Recorded";
      readonly requestId: RuntimeRequestId;
      readonly installationId: PluginInstallationId;
      readonly decision: "accept" | "decline";
    }
  /** The orchestrator refused the answer, usually because another answer was recorded first. */
  | {
      readonly _tag: "Refused";
      readonly requestId: RuntimeRequestId;
      readonly installationId: PluginInstallationId;
      readonly decision: "accept" | "decline";
      readonly message: string;
    }
  /** No plugin was asked about the request; it waits for the user. */
  | {
      readonly _tag: "Skipped";
      readonly requestId: RuntimeRequestId;
      /**
       * `overloaded`: `maxActiveOffers` requests were already being offered.
       * `incomplete`: its prompt or subject is longer than a plugin may receive.
       */
      readonly cause: "overloaded" | "incomplete";
    };

export class PluginApprovals extends Context.Service<
  PluginApprovals,
  {
    /** Subscribes before returning, so no receipt after this point is missed (sliding, 1024). */
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<PluginApprovalReceipt>,
      never,
      Scope.Scope
    >;
  }
>()("t3/plugins/PluginApprovals") {}

export interface PluginApprovalsOptions {
  /** Requests being offered at once; later ones are skipped. Default 32. */
  readonly maxActiveOffers?: number;
  /** Plugin calls running at once, across requests; later ones abstain. Default 16. */
  readonly maxActiveCalls?: number;
}

/** Finished requests remembered so a repeated pending update is not offered twice. */
const MAX_REMEMBERED_REQUESTS = 1024;

const isPluginApprovalKind = Schema.is(PluginApprovalKind);
const encodeRequest = Schema.encodeEffect(PluginApprovalRequest);
const decodeAnswer = Schema.decodeUnknownResult(PluginApprovalAnswer);
const isLiveStreamBufferError = Schema.is(LiveStreamBufferError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** True for an installation that is enabled, registered, consented to `approvals`, and declares `kind`. */
const answers = (installation: PluginInstallation, kind: PluginApprovalKind) =>
  installation.enabled &&
  installation.hostState !== undefined &&
  installation.consent?.capabilities.includes(PLUGIN_APPROVALS_CAPABILITY) === true &&
  installation.manifest?.approvals?.kinds.includes(kind) === true;

const abstainCause = (
  error: PluginCatalogError | PluginInvokeError,
): PluginApprovalAbstainCause => {
  switch (error._tag) {
    case "PluginTimeoutError":
      return "deadline";
    case "PluginCatalogError":
    case "PluginStoppedError":
    case "PluginNotEnabledError":
    case "PluginUnavailableError":
    case "PluginIncompatibleError":
    case "PluginBusyError":
      return "unavailable";
    default:
      return "failed";
  }
};

export const make = Effect.fn("PluginApprovals.make")(function* (
  options: PluginApprovalsOptions = {},
) {
  const catalog = yield* PluginCatalog;
  const eventSink = yield* EventSinkV2;
  const projections = yield* ProjectionStoreV2;
  const orchestrator = yield* OrchestratorV2;
  const environmentId: EnvironmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
  const scope = yield* Effect.scope;
  const receipts = yield* PubSub.sliding<PluginApprovalReceipt>(1024);
  const publish = (receipt: PluginApprovalReceipt) =>
    PubSub.publish(receipts, receipt).pipe(Effect.asVoid);
  const maxActiveOffers = options.maxActiveOffers ?? 32;
  // Covers each call from before the catalogue inspects the plugin until its answer is recorded.
  const calls = yield* Semaphore.make(options.maxActiveCalls ?? 16);

  /** One plugin's call for one request. Its answer is recorded even if the request is withdrawn meanwhile. */
  const ask = (
    installation: PluginInstallation,
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    input: Schema.Json,
  ) => {
    const { installationId, generation } = installation;
    const ids = { requestId, installationId };
    const abstain = (cause: PluginApprovalAbstainCause, message?: string) =>
      publish({ _tag: "Abstained", ...ids, cause, ...(message === undefined ? {} : { message }) });
    const timeoutSeconds =
      installation.manifest?.approvals?.timeoutSeconds ??
      PLUGIN_APPROVAL_LIMITS.defaultTimeoutSeconds;
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* publish({ _tag: "Asked", ...ids });
        const called = yield* restore(
          catalog.invoke(installationId, PLUGIN_APPROVAL_HANDLER, input, {
            timeout: `${timeoutSeconds} seconds`,
            generation,
          }),
        ).pipe(Effect.result);
        if (Result.isFailure(called))
          return yield* abstain(abstainCause(called.failure), called.failure.message);
        const answer = decodeAnswer(called.success);
        if (Result.isFailure(answer)) return yield* abstain("invalid", answer.failure.message);
        if (answer.success === null || answer.success.decision === "abstain")
          return yield* abstain("abstained", answer.success?.reason);
        const decision = answer.success.decision === "approve" ? "accept" : "decline";
        const { reason } = answer.success;
        const recorded = yield* orchestrator
          .dispatch({
            type: "runtime-request.plugin-respond",
            commandId: CommandId.make(
              `plugin-approval:${requestId}:${installationId}:${generation}`,
            ),
            threadId,
            requestId,
            resolvedBy: {
              _tag: "plugin",
              pluginId: installation.manifest?.id ?? "",
              pluginName: installation.manifest?.name ?? "",
              decision,
              ...(reason === undefined || reason.trim() === "" ? {} : { reason: reason.trim() }),
            },
          })
          .pipe(Effect.result);
        yield* Result.isSuccess(recorded)
          ? publish({ _tag: "Recorded", ...ids, decision })
          : publish({
              _tag: "Refused",
              ...ids,
              decision,
              message: userFacingDispatchErrorMessage(recorded.failure) ?? recorded.failure.message,
            });
      }),
    ).pipe(
      Effect.onInterrupt(() => abstain("withdrawn")),
      calls.withPermitsIfAvailable(1),
      Effect.flatMap((ran) => (Option.isSome(ran) ? Effect.void : abstain("overloaded"))),
    );
  };

  /** The tool call an approval is for: the item of the approval node's parent, if it has one yet. */
  const subjectOf = Effect.fn("PluginApprovals.subjectOf")(function* (
    threadId: ThreadId,
    parentNodeId: NodeId | null,
  ) {
    if (parentNodeId === null) return undefined;
    const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
      turnItemNodeIds: [parentNodeId],
      turnItemTypes: ["command_execution", "file_change", "dynamic_tool"],
    });
    const item = turnItems[0];
    switch (item?.type) {
      case "command_execution":
        return item.input;
      case "file_change":
        return (item.changes?.map((change) => change.path) ?? [item.fileName]).join("\n");
      case "dynamic_tool":
        return `${item.toolName ?? "tool"} ${encodeJson(item.input)}`;
      default:
        return undefined;
    }
  });

  /** Asks every participant at once about a request whose card shows `prompt`. */
  const offer = Effect.fn("PluginApprovals.offer")(
    function* (
      threadId: ThreadId,
      requestId: RuntimeRequestId,
      kind: PluginApprovalKind,
      prompt: string,
      context: ProjectionRuntimeResponseContext,
      participants: ReadonlyArray<PluginInstallation>,
    ) {
      const thread = yield* projections.getThreadShell(threadId);
      if (thread === null) return;
      const subject = yield* subjectOf(threadId, context.node?.parentNodeId ?? null);
      // An approve covers the whole request, so a plugin never decides on part of it.
      if (
        prompt.length > PLUGIN_APPROVAL_LIMITS.maxPromptLength ||
        (subject?.length ?? 0) > PLUGIN_APPROVAL_LIMITS.maxPromptLength
      )
        return yield* publish({ _tag: "Skipped", requestId, cause: "incomplete" });
      const input = yield* encodeRequest({
        requestId,
        kind,
        prompt,
        ...(subject === undefined ? {} : { subject }),
        context: {
          environmentId,
          projectId: thread.projectId,
          threadId,
          runId: context.node?.runId ?? null,
          provider: context.session?.driver ?? null,
        },
      });
      yield* Effect.forEach(
        participants,
        (installation) => ask(installation, threadId, requestId, input),
        { concurrency: "unbounded", discard: true },
      );
    },
    Effect.catch((error) =>
      Effect.logWarning("Could not offer an approval to plugins; it waits for the user", {
        error,
      }),
    ),
  );

  // Requests being offered, keyed by thread and request. Each entry owns its fiber's
  // cancellation and leaves only when the offer ends or is withdrawn.
  const active = new Map<string, { fiber?: Fiber.Fiber<void> }>();
  // Pending requests, by kind, whose approval card is not committed yet; the card starts
  // their offer. Insertion order makes the oldest the first to forget, here and below.
  const awaitingCard = new Map<string, PluginApprovalKind>();
  // Requests already offered or skipped.
  const finished = new Set<string>();
  const finish = (key: string) => {
    awaitingCard.delete(key);
    finished.delete(key);
    finished.add(key);
    if (finished.size > MAX_REMEMBERED_REQUESTS)
      finished.delete(finished.values().next().value as string);
  };

  /**
   * Starts the offer of a pending request once its approval card, with the
   * prompt, is committed too. The watch handles one event at a time and this
   * reads both after its event committed, so whichever of the two commits
   * second starts the offer. Nothing to ask starts no process.
   */
  const consider = Effect.fn("PluginApprovals.consider")(
    function* (
      threadId: ThreadId,
      requestId: RuntimeRequestId,
      kind: PluginApprovalKind,
      key: string,
    ) {
      const participants = (yield* catalog.list).installations.filter((installation) =>
        answers(installation, kind),
      );
      if (participants.length === 0) return;
      const context = yield* projections.getRuntimeResponseContext(threadId, requestId);
      const { request, item } = context;
      if (request?.status !== "pending" || request.responseCapability.type !== "live") return;
      if (item?.type !== "approval_request" || item.prompt === undefined) {
        awaitingCard.delete(key);
        awaitingCard.set(key, kind);
        if (awaitingCard.size > MAX_REMEMBERED_REQUESTS)
          awaitingCard.delete(awaitingCard.keys().next().value as string);
        return;
      }
      if (active.size >= maxActiveOffers) {
        finish(key);
        return yield* publish({ _tag: "Skipped", requestId, cause: "overloaded" });
      }
      awaitingCard.delete(key);
      const entry: { fiber?: Fiber.Fiber<void> } = {};
      active.set(key, entry);
      entry.fiber = yield* offer(
        threadId,
        requestId,
        kind,
        item.prompt,
        context,
        participants,
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (active.get(key) !== entry) return;
            active.delete(key);
            finish(key);
          }),
        ),
        Effect.forkIn(scope),
      );
    },
    Effect.catch((error) =>
      Effect.logWarning("Could not offer an approval to plugins; it waits for the user", {
        error,
      }),
    ),
  );

  const keyOf = (threadId: ThreadId, requestId: RuntimeRequestId) =>
    `${threadId}\u0000${requestId}`;
  const onRequest = (request: OrchestrationV2RuntimeRequest, threadId: ThreadId) =>
    Effect.suspend(() => {
      const key = keyOf(threadId, request.id);
      const answerable = request.status === "pending" && request.responseCapability.type === "live";
      const current = active.get(key);
      if (!answerable) {
        awaitingCard.delete(key);
        if (current === undefined) return Effect.void;
        active.delete(key);
        finish(key);
        // Withdraws the calls still running, without waiting for an answer being recorded.
        return current.fiber === undefined
          ? Effect.void
          : Fiber.interrupt(current.fiber).pipe(Effect.forkIn(scope), Effect.asVoid);
      }
      if (current !== undefined || finished.has(key) || !isPluginApprovalKind(request.kind))
        return Effect.void;
      return consider(threadId, request.id, request.kind, key);
    });
  const onCard = (item: OrchestrationV2TurnItem, threadId: ThreadId) => {
    if (item.type !== "approval_request") return Effect.void;
    const key = keyOf(threadId, item.requestId);
    const kind = awaitingCard.get(key);
    return kind === undefined ? Effect.void : consider(threadId, item.requestId, kind, key);
  };

  // Each resubscription resumes after the last event seen of its type, so none is skipped.
  const head = yield* eventSink.latestSequence();
  const cursors = { "runtime-request.updated": head, "turn-item.updated": head };
  const watch = Effect.suspend(() =>
    Stream.mergeAll(
      (["runtime-request.updated", "turn-item.updated"] as const).map((eventType) =>
        eventSink.stream({ eventType, afterSequence: cursors[eventType], bounded: true }),
      ),
      { concurrency: "unbounded" },
    ).pipe(
      Stream.runForEach((stored: OrchestrationV2StoredEvent) => {
        const { event } = stored;
        switch (event.type) {
          case "runtime-request.updated":
            cursors[event.type] = stored.sequence;
            return onRequest(event.payload, event.threadId);
          case "turn-item.updated":
            cursors[event.type] = stored.sequence;
            return onCard(event.payload, event.threadId);
          default:
            return Effect.void;
        }
      }),
    ),
  );
  const fellBehind = (error: EventSinkV2Error) =>
    error._tag === "EventSinkStreamError" && isLiveStreamBufferError(error.cause);
  yield* watch.pipe(
    Effect.retry({ while: fellBehind }),
    Effect.tapError((error) => Effect.logWarning("Plugin approval offers stopped", { error })),
    Effect.retry(Schedule.spaced("1 minute")),
    Effect.forkScoped,
  );

  return PluginApprovals.of({ subscribe: PubSub.subscribe(receipts) });
});

export const layer = Layer.effect(PluginApprovals, make());
