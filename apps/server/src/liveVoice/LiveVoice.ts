import {
  CommandId,
  MessageId,
  LiveVoiceError,
  type AuthSessionId,
  type ThreadId,
  type LiveVoiceOptions,
  type LiveVoiceStart,
  type LiveVoiceState,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ProviderLiveVoice } from "@t3tools/provider-core/server/driver";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ProviderInstances from "../provider/ProviderInstanceRegistry.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { VoiceEvent, voiceContextChunks, voiceDelegation } from "./protocol.ts";

const isLiveVoiceError = Schema.is(LiveVoiceError);
const decodeVoiceEvent = Schema.decodeEffect(Schema.fromJsonString(VoiceEvent));

type Connection = Effect.Success<ReturnType<ProviderLiveVoice["open"]>>;
type Entry = {
  id: string;
  owner: AuthSessionId;
  threadId: ThreadId;
  scope: Scope.Closeable;
  instance: ProviderInstance;
  authStamp: string;
  selection: string;
  connection?: Connection;
  state: LiveVoiceState;
  changed: Deferred.Deferred<void>;
  expires: number;
  closed: boolean;
  delegated: Set<string>;
};

export class LiveVoice extends Context.Service<
  LiveVoice,
  {
    readonly options: (threadId: ThreadId) => Effect.Effect<LiveVoiceOptions, LiveVoiceError>;
    readonly start: (
      input: LiveVoiceStart,
      owner: AuthSessionId,
    ) => Effect.Effect<{ readonly sdp: string }, LiveVoiceError>;
    readonly poll: (
      id: string,
      owner: AuthSessionId,
      revision: number,
    ) => Effect.Effect<LiveVoiceState, LiveVoiceError>;
    readonly stop: (id: string, owner: AuthSessionId) => Effect.Effect<void, LiveVoiceError>;
  }
>()("t3/liveVoice/LiveVoice") {}

const make = Effect.gen(function* () {
  const providers = yield* ProviderInstances.ProviderInstanceRegistry;
  const projections = yield* Projections.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const serviceScope = yield* Scope.Scope;
  const entries = new Map<string, Entry>();
  const byThread = new Map<ThreadId, string>();
  const unavailable = () => new LiveVoiceError({ reason: "unavailable" });
  const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
  const load = Effect.fn("LiveVoice.load")(
    function* (threadId: ThreadId) {
      const snapshot = yield* projections.getThreadSnapshotWindow(threadId, {
        rowLimit: 40,
        userTurnLimit: 10,
      });
      const { thread } = snapshot.projection;
      const instance = yield* providers.getInstance(thread.modelSelection.instanceId);
      if (!instance?.enabled || !instance.liveVoice || thread.archivedAt !== null)
        return yield* unavailable();
      const account = yield* instance.snapshot.getSnapshot;
      return {
        instance,
        voice: instance.liveVoice,
        projection: snapshot.projection,
        authStamp: yield* encodeJson(account.auth),
        selection: yield* encodeJson(thread.modelSelection),
      };
    },
    Effect.mapError((error) => (isLiveVoiceError(error) ? error : unavailable())),
  );
  const publish = Effect.fn("LiveVoice.publish")(function* (
    entry: Entry,
    update: Partial<LiveVoiceState>,
  ) {
    entry.state = { ...entry.state, ...update, revision: entry.state.revision + 1 };
    const previous = entry.changed;
    entry.changed = yield* Deferred.make<void>();
    yield* Deferred.succeed(previous, undefined);
  });
  const finish = Effect.fn("LiveVoice.finish")(function* (
    entry: Entry,
    error: string | null = null,
  ) {
    if (entry.closed) return;
    entry.closed = true;
    if (byThread.get(entry.threadId) === entry.id) byThread.delete(entry.threadId);
    yield* publish(entry, { phase: error ? "error" : "ended", error });
    yield* Scope.close(entry.scope, Exit.void);
    entry.expires = (yield* Clock.currentTimeMillis) + 45_000;
  });
  const current = Effect.fn("LiveVoice.current")(function* (entry: Entry) {
    const selected = yield* load(entry.threadId);
    if (
      selected.instance !== entry.instance ||
      selected.authStamp !== entry.authStamp ||
      selected.selection !== entry.selection
    ) {
      return yield* new LiveVoiceError({ reason: "thread-changed" });
    }
    return selected;
  });
  const speak = Effect.fn("LiveVoice.speak")(function* (
    entry: Entry,
    delegation: string,
    text: string,
  ) {
    for (const chunk of voiceContextChunks(text.slice(0, 8000))) {
      yield* entry.connection!.send({
        type: "delegation.context.append",
        delegation_item_id: delegation,
        channel: "speakable",
        content: [{ type: "input_text", text: chunk }],
      });
    }
  });
  // Control frames share the session lifecycle; avoid a trace span for each streamed event.
  const handle = Effect.fnUntraced(function* (entry: Entry, raw: string) {
    const event = yield* decodeVoiceEvent(raw);
    if (entry.closed) return;
    if (event.type === "error") {
      yield* finish(entry, "The voice service ended the connection.").pipe(
        Effect.forkIn(serviceScope),
      );
      return;
    }
    if (
      event.type === "turn.done" &&
      event.turn &&
      (event.turn.role === "user" || event.turn.role === "assistant") &&
      event.turn.transcript
    ) {
      const transcript: LiveVoiceState["transcripts"][number] = {
        id: event.turn.id,
        role: event.turn.role,
        text: event.turn.transcript.slice(0, 16_384),
      };
      yield* publish(entry, {
        transcripts: [
          ...entry.state.transcripts.filter((item) => item.id !== transcript.id),
          transcript,
        ].slice(-100),
      });
    }
    const task = voiceDelegation(event);
    if (!task || entry.delegated.has(task.id)) return;
    entry.delegated.add(task.id);
    yield* current(entry);
    if (entry.closed) return;
    const dispatched = yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`voice:${entry.id}:${task.id}`),
      messageId: MessageId.make(`voice:${entry.id}:${task.id}`),
      threadId: entry.threadId,
      createdBy: "user",
      creationSource: "web",
      text: task.text,
      attachments: [],
      deliveryIntent: "auto",
      dispatchMode: { type: "start_immediately" },
    });
    const runIds = new Set(
      dispatched.storedEvents.flatMap(({ event }) =>
        event.type === "run.created"
          ? [event.payload.id]
          : event.type === "message.updated" && event.payload.role === "user" && event.payload.runId
            ? [event.payload.runId]
            : [],
      ),
    );
    yield* orchestrator
      .streamStoredEventsFrom({ threadId: entry.threadId, afterSequence: dispatched.sequence })
      .pipe(
        Stream.map((stored) => stored.event),
        Stream.filter(
          (event) =>
            event.type === "run.updated" &&
            runIds.has(event.payload.id) &&
            ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
              event.payload.status,
            ),
        ),
        Stream.take(1),
        Stream.runForEach(
          Effect.fn("LiveVoice.deliverResult")(function* (event) {
            if (event.type !== "run.updated") return;
            const snapshot = yield* projections.getThreadSnapshotWindow(entry.threadId, {
              rowLimit: 40,
              requiredRunId: event.payload.id,
            });
            const reply = snapshot.projection.messages
              .filter(
                (message) =>
                  message.runId === event.payload.id &&
                  message.role === "assistant" &&
                  !message.streaming,
              )
              .at(-1)?.text;
            const result =
              event.payload.status === "completed"
                ? reply || "The coding task completed. See the T3 conversation for details."
                : `The coding task ${event.payload.status}. Check the T3 conversation for details.`;
            yield* speak(entry, task.id, result);
          }),
        ),
        Effect.catch(() =>
          speak(entry, task.id, "The task result could not be read. Check the conversation in T3."),
        ),
        Effect.forkIn(entry.scope),
      );
  });
  const owned = Effect.fn("LiveVoice.owned")(function* (id: string, owner: AuthSessionId) {
    const entry = entries.get(id);
    if (!entry || entry.owner !== owner) return yield* new LiveVoiceError({ reason: "expired" });
    return entry;
  });
  yield* Effect.addFinalizer(() =>
    Effect.forEach(entries.values(), (entry) => finish(entry), { discard: true }),
  );
  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep("10 seconds");
      const now = yield* Clock.currentTimeMillis;
      for (const entry of entries.values()) {
        if (entry.expires > now) continue;
        yield* finish(entry);
        entries.delete(entry.id);
      }
    }
  }).pipe(Effect.forkScoped);
  return LiveVoice.of({
    options: Effect.fn("LiveVoice.options")(function* (threadId) {
      return yield* (yield* load(threadId)).voice.options;
    }),
    start: Effect.fn("LiveVoice.start")(function* (input, owner) {
      if (entries.has(input.sessionId) || byThread.has(input.threadId))
        return yield* new LiveVoiceError({ reason: "busy" });
      byThread.set(input.threadId, input.sessionId);
      const scope = yield* Scope.make();
      let entry: Entry | undefined;
      return yield* Effect.gen(function* () {
        const selected = yield* load(input.threadId);
        entry = {
          id: input.sessionId,
          owner,
          threadId: input.threadId,
          scope,
          instance: selected.instance,
          authStamp: selected.authStamp,
          selection: selected.selection,
          state: { revision: 0, phase: "connected", transcripts: [], error: null },
          changed: yield* Deferred.make<void>(),
          expires: (yield* Clock.currentTimeMillis) + 45_000,
          closed: false,
          delegated: new Set(),
        };
        entries.set(entry.id, entry);
        const context = selected.projection.messages
          .filter((message) => message.role !== "system" && !message.streaming)
          .slice(-20)
          .map((message) => ({
            role: message.role as "user" | "assistant",
            text: message.text.slice(-1500),
          }));
        const connection = yield* selected.voice
          .open({ sdp: input.sdp, voice: input.voice, context })
          .pipe(Effect.provideService(Scope.Scope, scope));
        if (entry.closed) return yield* new LiveVoiceError({ reason: "expired" });
        entry.connection = connection;
        const active = entry;
        yield* connection.events.pipe(
          Stream.runForEach((event) => handle(active, event)),
          Effect.matchEffect({
            onSuccess: () => finish(active),
            onFailure: () =>
              finish(active, "Voice disconnected. Your T3 tasks remain in the conversation."),
          }),
          Effect.forkIn(serviceScope),
        );
        return { sdp: connection.sdp };
      }).pipe(
        Effect.onError(() => {
          if (byThread.get(input.threadId) === input.sessionId) byThread.delete(input.threadId);
          entries.delete(input.sessionId);
          return Scope.close(scope, Exit.void);
        }),
      );
    }),
    poll: Effect.fn("LiveVoice.poll")(function* (id, owner, revision) {
      const entry = yield* owned(id, owner);
      if (!entry.closed) {
        yield* current(entry).pipe(Effect.catch((error) => finish(entry, error.message)));
        entry.expires = (yield* Clock.currentTimeMillis) + 45_000;
      }
      if (!entry.closed && entry.state.revision === revision)
        yield* Deferred.await(entry.changed).pipe(Effect.timeoutOption("15 seconds"));
      return entry.state;
    }),
    stop: Effect.fn("LiveVoice.stop")(function* (id, owner) {
      yield* finish(yield* owned(id, owner));
    }),
  });
});
export const layer = Layer.effect(LiveVoice, make);
