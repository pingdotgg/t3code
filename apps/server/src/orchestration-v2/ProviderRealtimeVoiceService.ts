import {
  ProviderRealtimeVoiceError,
  type ProviderRealtimeVoiceStartInput,
  type ProviderRealtimeVoiceStartResult,
  type ProviderRealtimeVoiceStopInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isContextHandoffRedeliverable } from "./ContextHandoffDelivery.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

/** Starts and stops realtime voice on a thread's active provider binding. */
export class ProviderRealtimeVoiceServiceV2 extends Context.Service<
  ProviderRealtimeVoiceServiceV2,
  {
    /**
     * Loads a stopped or unloaded thread through the same policy-aware session open a turn
     * uses, without starting a turn. The adapter keeps its four-hour call lifetime.
     */
    readonly start: (
      input: ProviderRealtimeVoiceStartInput,
    ) => Effect.Effect<ProviderRealtimeVoiceStartResult, ProviderRealtimeVoiceError>;
    /** Never opens a session: stopping only reaches the live session that owns the call. */
    readonly stop: (
      input: ProviderRealtimeVoiceStopInput,
    ) => Effect.Effect<void, ProviderRealtimeVoiceError>;
  }
>()("t3/orchestration-v2/ProviderRealtimeVoiceService/ProviderRealtimeVoiceServiceV2") {}

const isProviderRealtimeVoiceError = Schema.is(ProviderRealtimeVoiceError);

// A run in these states already holds its provider thread; reloading it could reset the turn.
const PROVIDER_HOLDING_RUN_STATUSES = new Set(["starting", "running", "waiting"]);
const SETTLED_RUN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export const layer: Layer.Layer<
  ProviderRealtimeVoiceServiceV2,
  never,
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RuntimePolicyV2
> = Layer.effect(
  ProviderRealtimeVoiceServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;

    // Only for refusals before any provider call, so clients know no call can be left open.
    const fail = (threadId: ThreadId, cause: string) =>
      new ProviderRealtimeVoiceError({ threadId, cause, refusedBeforeStart: true });

    const resolve = Effect.fn("ProviderRealtimeVoiceService.resolve")(function* (
      threadId: ThreadId,
      source: { readonly providerThreadId?: string; readonly providerSessionId?: string },
      load: boolean,
    ) {
      const records = yield* projections.getThreadRecords(
        threadId,
        ["providerThreads", "providerSessions", "runs", "contextHandoffs", "messages"],
        { messageRoles: ["user"] },
      );
      const providerThread =
        source.providerThreadId === undefined
          ? (records.providerThreads.find(
              (candidate) => candidate.id === records.thread.activeProviderThreadId,
            ) ?? records.providerThreads.at(-1))
          : records.providerThreads.find((candidate) => candidate.id === source.providerThreadId);
      const providerSessionId = providerThread?.providerSessionId ?? null;
      if (
        source.providerThreadId === undefined &&
        (providerThread?.id !== records.thread.activeProviderThreadId ||
          providerThread?.providerInstanceId !== records.thread.providerInstanceId)
      )
        return yield* fail(threadId, "No active matching provider thread is available for voice.");
      if (
        providerThread?.appThreadId !== threadId ||
        (source.providerSessionId !== undefined && source.providerSessionId !== providerSessionId)
      )
        return yield* fail(threadId, "Voice provider ownership no longer matches.");
      if (providerThread === undefined || providerSessionId === null)
        return yield* fail(threadId, "No provider session has run in this thread yet.");
      const live = Option.getOrNull(yield* sessions.get(providerSessionId));
      if (!load) {
        if (live === null)
          return yield* fail(threadId, "The provider session is no longer running.");
        return { providerThread, runtime: live };
      }
      if (providerThread.nativeThreadRef?.nativeId == null)
        return yield* fail(threadId, "Send a message in this conversation before starting voice.");
      // Only a turn delivers handoffs; voice would start without history a turn still owes it.
      // Handoffs stay `ready` after delivery, so a settled target run counts as delivered.
      const localProviderThreadIds = new Set(records.providerThreads.map((thread) => thread.id));
      if (
        records.contextHandoffs.some((handoff) => {
          if (handoff.status !== "ready" || handoff.toProviderThreadId !== providerThread.id)
            return false;
          // Already in this native thread's history; a turn would skip it too.
          if (
            handoff.delivery !== undefined &&
            handoff.delivery.status !== "pending" &&
            handoff.delivery.nativeThreadId === providerThread.nativeThreadRef?.nativeId
          )
            return false;
          const target = records.runs.find((run) => run.id === handoff.targetRunId);
          return (
            target === undefined ||
            !SETTLED_RUN_STATUSES.has(target.status) ||
            isContextHandoffRedeliverable(
              handoff,
              records.runs,
              records.messages,
              localProviderThreadIds,
            )
          );
        })
      )
        return yield* fail(
          threadId,
          "Send a message first so the agent receives this conversation's earlier history.",
        );
      // A loaded thread is never reloaded for voice: that could change its model or reset a
      // turn that started after the run check.
      if (
        live !== null &&
        (records.runs.some((run) => PROVIDER_HOLDING_RUN_STATUSES.has(run.status)) ||
          (yield* sessions.isThreadLoaded({ providerSessionId, threadId })))
      )
        return { providerThread, runtime: live };
      // Load with the settings this thread's last turn used, as the next turn would find it.
      const modelSelection =
        records.runs.findLast((run) => run.providerThreadId === providerThread.id)
          ?.modelSelection ?? records.thread.modelSelection;
      const resolvedPolicy = yield* runtimePolicy.resolve({
        thread: records.thread,
        modelSelection,
      });
      const existingSession = records.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      const runtime =
        live ??
        (yield* sessions.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy: resolvedPolicy,
          ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
          initialNativeThreadId: providerThread.nativeThreadRef.nativeId,
          ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
            ? {}
            : {
                initialProviderItemIdentityVersion:
                  providerThread.nativeMetadata.itemIdentityVersion,
              }),
        }));
      // A no-op when the session already holds this thread with the same settings.
      const loaded = yield* runtime.resumeThread({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy: resolvedPolicy,
      });
      return { providerThread: loaded, runtime };
    });

    const mapError = (threadId: ThreadId) =>
      Effect.mapError((cause: unknown) =>
        isProviderRealtimeVoiceError(cause)
          ? cause
          : new ProviderRealtimeVoiceError({ threadId, cause }),
      );

    return ProviderRealtimeVoiceServiceV2.of({
      start: Effect.fn("ProviderRealtimeVoiceService.start")(
        function* (input) {
          const { providerThread, runtime } = yield* resolve(input.threadId, {}, true);
          if (runtime.startRealtimeVoice === undefined)
            return yield* fail(
              input.threadId,
              `Provider '${runtime.driver}' does not support realtime voice.`,
            );
          return yield* runtime.startRealtimeVoice({
            providerThread,
            sdp: input.sdp,
            ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
          });
        },
        (effect, input) => effect.pipe(mapError(input.threadId)),
      ),
      stop: Effect.fn("ProviderRealtimeVoiceService.stop")(
        function* (input) {
          if (
            (input.operationId !== undefined || input.voiceSessionToken !== undefined) &&
            (input.operationId === undefined ||
              input.voiceSessionToken === undefined ||
              input.providerSessionId === undefined ||
              input.providerThreadId === undefined)
          )
            return yield* fail(
              input.threadId,
              "Owned voice stop requires its original operation, token and provider identity.",
            );
          const { providerThread, runtime } = yield* resolve(
            input.threadId,
            {
              ...(input.providerThreadId === undefined
                ? {}
                : { providerThreadId: input.providerThreadId }),
              ...(input.providerSessionId === undefined
                ? {}
                : { providerSessionId: input.providerSessionId }),
            },
            false,
          );
          if (runtime.stopRealtimeVoice === undefined)
            return yield* fail(
              input.threadId,
              `Provider '${runtime.driver}' does not support realtime voice.`,
            );
          return yield* runtime.stopRealtimeVoice({
            providerThread,
            ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
            ...(input.voiceSessionToken === undefined
              ? {}
              : { voiceSessionToken: input.voiceSessionToken }),
          });
        },
        (effect, input) => effect.pipe(mapError(input.threadId)),
      ),
    });
  }),
);
