import {
  PluginId,
  ThreadId,
  TrimmedNonEmptyString,
  type PluginThreadStatusesEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { subscribeBeforeSnapshotWithoutMutex } from "../utils/subscribeBeforeSnapshot.ts";

export class PluginThreadStatusError extends Schema.TaggedError<PluginThreadStatusError>()(
  "PluginThreadStatusError",
  { message: Schema.String },
) {}

interface Owner {
  readonly pluginId: PluginId;
  readonly pluginName: string;
  readonly deactivated: AbortSignal;
}

export class PluginThreadStatuses extends Context.Service<
  PluginThreadStatuses,
  {
    readonly set: (owner: Owner, input: unknown) => Effect.Effect<void, PluginThreadStatusError>;
    readonly clear: (owner: Owner, input: unknown) => Effect.Effect<void, PluginThreadStatusError>;
    readonly clearPlugin: (pluginId: PluginId) => Effect.Effect<void>;
    readonly subscribe: (threadId: ThreadId) => Stream.Stream<PluginThreadStatusesEvent>;
  }
>()("t3/plugins/PluginThreadStatuses") {}

const KeyInput = Schema.Struct({
  threadId: ThreadId,
  key: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]{1,64}$/)),
});
const SetInput = Schema.Struct({
  ...KeyInput.fields,
  text: TrimmedNonEmptyString.check(
    Schema.isMaxLength(200),
    Schema.isPattern(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u),
  ),
});
const decodeKey = Schema.decodeUnknownEffect(KeyInput);
const decodeSet = Schema.decodeUnknownEffect(SetInput);
const empty: PluginThreadStatusesEvent = { plugins: [] };
const invalid = () =>
  new PluginThreadStatusError({
    message:
      "A status needs a thread, a 1–64 character key (letters, digits, dot, underscore or hyphen), and up to 200 characters of single-line text.",
  });

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const changes = yield* PubSub.sliding<void>(1);
  const mutex = yield* Semaphore.make(1);
  const plugins = new Map<
    PluginId,
    { name: string; threads: Map<ThreadId, Map<string, string>> }
  >();
  const snapshots = new Map<ThreadId, PluginThreadStatusesEvent>();
  const snapshot = (threadId: ThreadId) => Effect.sync(() => snapshots.get(threadId) ?? empty);
  const publish = Effect.fn("PluginThreadStatuses.publish")(function* (threadId: ThreadId) {
    const entries = [...plugins].flatMap(([pluginId, plugin]) => {
      const statuses = plugin.threads.get(threadId);
      return statuses?.size
        ? [
            {
              pluginId,
              pluginName: plugin.name,
              statuses: [...statuses].map(([key, text]) => ({ key, text })),
            },
          ]
        : [];
    });
    if (entries.length) snapshots.set(threadId, { plugins: entries });
    else snapshots.delete(threadId);
    yield* PubSub.publish(changes, undefined);
  });
  const checkActive = (owner: Owner) =>
    owner.deactivated.aborted
      ? Effect.fail(new PluginThreadStatusError({ message: "This plugin activation has ended." }))
      : Effect.void;

  return PluginThreadStatuses.of({
    set: Effect.fn("PluginThreadStatuses.set")(function* (owner, input) {
      yield* checkActive(owner);
      const { threadId, key, text } = yield* decodeSet(input).pipe(Effect.mapError(invalid));
      const thread = yield* projections
        .getThread(threadId)
        .pipe(
          Effect.mapError(
            () => new PluginThreadStatusError({ message: "This thread could not be found." }),
          ),
        );
      if (thread.deletedAt !== null)
        return yield* new PluginThreadStatusError({ message: "This thread has been deleted." });
      yield* mutex.withPermit(
        Effect.gen(function* () {
          yield* checkActive(owner);
          const plugin = plugins.get(owner.pluginId) ?? {
            name: owner.pluginName,
            threads: new Map<ThreadId, Map<string, string>>(),
          };
          if (!plugin.threads.has(threadId) && plugin.threads.size >= 64)
            return yield* new PluginThreadStatusError({
              message: "A plugin can show statuses on at most 64 threads.",
            });
          const statuses = plugin.threads.get(threadId) ?? new Map<string, string>();
          if (!statuses.has(key) && statuses.size >= 8)
            return yield* new PluginThreadStatusError({
              message: "A plugin can show at most 8 statuses on a thread.",
            });
          if (statuses.get(key) === text) return;
          statuses.set(key, text);
          plugin.threads.set(threadId, statuses);
          plugins.set(owner.pluginId, plugin);
          yield* publish(threadId);
        }).pipe(Effect.uninterruptible),
      );
    }),
    clear: Effect.fn("PluginThreadStatuses.clear")(function* (owner, input) {
      const { threadId, key } = yield* decodeKey(input).pipe(Effect.mapError(invalid));
      yield* mutex.withPermit(
        Effect.gen(function* () {
          yield* checkActive(owner);
          const plugin = plugins.get(owner.pluginId);
          const statuses = plugin?.threads.get(threadId);
          if (!statuses?.delete(key)) return;
          if (statuses.size === 0) plugin!.threads.delete(threadId);
          if (plugin!.threads.size === 0) plugins.delete(owner.pluginId);
          yield* publish(threadId);
        }).pipe(Effect.uninterruptible),
      );
    }),
    clearPlugin: Effect.fn("PluginThreadStatuses.clearPlugin")(function* (pluginId) {
      yield* mutex.withPermit(
        Effect.gen(function* () {
          const plugin = plugins.get(pluginId);
          if (!plugin) return;
          plugins.delete(pluginId);
          for (const threadId of plugin.threads.keys()) yield* publish(threadId);
        }).pipe(Effect.uninterruptible),
      );
    }),
    subscribe: (threadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscribed = yield* subscribeBeforeSnapshotWithoutMutex(changes, Effect.void);
          return Stream.concat(
            Stream.fromEffect(snapshot(threadId)),
            subscribed.changes.pipe(Stream.mapEffect(() => snapshot(threadId))),
          ).pipe(Stream.changesWith((a, b) => a === b));
        }),
      ),
  });
});

export const layer = Layer.effect(PluginThreadStatuses, make);
