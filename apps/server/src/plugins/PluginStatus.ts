/**
 * Thread statuses set by plugins with the `status` capability.
 *
 * A plugin is a status producer like a provider session: its items go through
 * the shared contribution status store as one `plugin` source per plugin, so
 * every client that renders provider statuses renders them too. Statuses
 * belong to the plugin's running process: they are cleared on every client
 * when that process's generation is disabled, removed, or exits for any
 * reason, and the next process starts with none.
 */
import {
  CONTRIBUTION_STATUS_TEXT_MAX_LENGTH,
  PLUGIN_STATUS_CAPABILITY,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  type ContributionStatusSourceHandle,
  ContributionStatusStore,
  isValidContributionStatusKey,
  normalizeContributionStatusText,
} from "@t3tools/provider-core/server/ContributionStatusStore";
import type { PluginRegistration } from "./PluginManifestLoader.ts";
import {
  PluginHostCallError,
  type PluginHostMethod,
  PluginSupervisor,
} from "./PluginSupervisor.ts";
import { makeTokenBucket } from "./pluginTokenBucket.ts";

/**
 * Per plugin process: at most `maxItems` statuses across all threads (and the
 * store's 8 per thread), and `burst` sets at once, then one per `refillMillis`.
 * Clears are not limited: each one removes something a limited set added.
 */
const PLUGIN_STATUS_LIMITS = { maxItems: 16, burst: 10, refillMillis: 500 } as const;

type HostCall = Parameters<PluginHostMethod>[0];

const StatusTone = Schema.Literals(["neutral", "info", "success", "warning", "error"]);
const decodeSetInput = Schema.decodeUnknownEffect(
  Schema.Struct({
    threadId: ThreadId,
    key: Schema.String,
    text: Schema.String,
    tone: Schema.optionalKey(StatusTone),
    tooltip: Schema.optionalKey(Schema.String),
  }),
);
const decodeClearInput = Schema.decodeUnknownEffect(
  Schema.Struct({ threadId: ThreadId, key: Schema.String }),
);

const hostError = (message: string) => new PluginHostCallError({ message });
const STOPPED = hostError("The plugin was stopped.");

interface ThreadStatuses {
  readonly scope: Scope.Closeable;
  readonly handle: ContributionStatusSourceHandle;
  /** Keys this process has shown on the thread; the store may still drop one at capacity. */
  readonly keys: Set<string>;
}

/** What one plugin process has set. Calls run one at a time, in arrival order. */
interface Generation {
  readonly lock: Semaphore.Semaphore;
  readonly threads: Map<ThreadId, ThreadStatuses>;
  readonly bucket: ReturnType<typeof makeTokenBucket>;
  closed: boolean;
}

const checkCapability = (registration: PluginRegistration) =>
  registration.manifest.capabilities.includes(PLUGIN_STATUS_CAPABILITY)
    ? Effect.void
    : Effect.fail(
        hostError(`The plugin did not declare the "${PLUGIN_STATUS_CAPABILITY}" capability.`),
      );

const checkKey = (key: string) =>
  isValidContributionStatusKey(key)
    ? Effect.void
    : Effect.fail(hostError("Status keys must be 1 to 64 characters without control characters."));

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("PluginStatus.make")(function* () {
  const supervisor = yield* PluginSupervisor;
  const store = yield* ContributionStatusStore;
  const generations = new WeakMap<Scope.Scope, Generation>();

  /** The calling process's state, created on its first status call. */
  const generationOf = Effect.fnUntraced(function* (lifetime: Scope.Scope) {
    const existing = generations.get(lifetime);
    if (existing !== undefined) return existing;
    const generation: Generation = {
      lock: yield* Semaphore.make(1),
      threads: new Map(),
      bucket: makeTokenBucket(PLUGIN_STATUS_LIMITS),
      closed: false,
    };
    generations.set(lifetime, generation);
    // The handles' own scopes, children of the lifetime, clear what they set.
    yield* Scope.addFinalizer(
      lifetime,
      Effect.sync(() => {
        generation.closed = true;
      }),
    );
    return generation;
  });

  /** Runs `body` under the process's lock, refused once the process has stopped. */
  const serialized = <A>(
    call: HostCall,
    body: (generation: Generation) => Effect.Effect<A, PluginHostCallError>,
  ) =>
    Effect.gen(function* () {
      const generation = yield* generationOf(call.lifetime);
      return yield* generation.lock.withPermit(
        Effect.suspend(() =>
          generation.closed
            ? Effect.fail(STOPPED)
            : call.admitted.pipe(Effect.andThen(body(generation))),
        ),
      );
    });

  const statusSet: PluginHostMethod = (call) =>
    Effect.gen(function* () {
      yield* checkCapability(call.registration);
      const input = yield* decodeSetInput(call.input).pipe(
        Effect.mapError(() =>
          hostError(
            "A status needs threadId, key and text strings; tone is neutral, info, success, warning or error.",
          ),
        ),
      );
      yield* checkKey(input.key);
      const clears =
        normalizeContributionStatusText(input.text, CONTRIBUTION_STATUS_TEXT_MAX_LENGTH).length ===
        0;
      return yield* serialized(call, (generation) =>
        Effect.gen(function* () {
          const existing = generation.threads.get(input.threadId);
          if (clears) {
            if (existing !== undefined) yield* clearKey(generation, input.threadId, input.key);
            return null;
          }
          if (existing?.keys.has(input.key) !== true) {
            let shown = 0;
            for (const thread of generation.threads.values()) shown += thread.keys.size;
            if (shown >= PLUGIN_STATUS_LIMITS.maxItems)
              return yield* hostError(
                `A plugin can show at most ${PLUGIN_STATUS_LIMITS.maxItems} statuses at once; clear one first.`,
              );
          }
          if (!(yield* generation.bucket.take))
            return yield* hostError(
              `Too many status updates: at most ${PLUGIN_STATUS_LIMITS.burst} at once, then ${1000 / PLUGIN_STATUS_LIMITS.refillMillis} per second.`,
            );
          const thread = existing ?? (yield* openThread(call, generation, input.threadId));
          yield* thread.handle.set({
            key: input.key,
            text: input.text,
            ...(input.tone === undefined ? {} : { tone: input.tone }),
            ...(input.tooltip === undefined ? {} : { tooltip: input.tooltip }),
          });
          thread.keys.add(input.key);
          return null;
        }),
      );
    });

  const openThread = Effect.fnUntraced(function* (
    call: HostCall,
    generation: Generation,
    threadId: ThreadId,
  ) {
    // Closed with the process's lifetime, or when its thread's last status clears.
    const scope = yield* Scope.fork(call.lifetime, "sequential");
    const handle = yield* store
      .openSource({
        kind: "plugin",
        pluginId: call.registration.manifest.id,
        name: call.registration.manifest.name,
      })
      .pipe(Scope.provide(scope));
    yield* handle.bindThread(threadId);
    const thread: ThreadStatuses = { scope, handle, keys: new Set() };
    generation.threads.set(threadId, thread);
    return thread;
  });

  const clearKey = Effect.fnUntraced(function* (
    generation: Generation,
    threadId: ThreadId,
    key: string,
  ) {
    const thread = generation.threads.get(threadId);
    if (thread === undefined || !thread.keys.delete(key)) return;
    if (thread.keys.size > 0) return yield* thread.handle.clear(key);
    generation.threads.delete(threadId);
    yield* Scope.close(thread.scope, Exit.void);
  });

  const statusClear: PluginHostMethod = (call) =>
    Effect.gen(function* () {
      yield* checkCapability(call.registration);
      const input = yield* decodeClearInput(call.input).pipe(
        Effect.mapError(() => hostError("Clearing a status needs threadId and key strings.")),
      );
      yield* checkKey(input.key);
      return yield* serialized(call, (generation) =>
        clearKey(generation, input.threadId, input.key).pipe(Effect.as(null)),
      );
    });

  yield* supervisor.serveHostMethod("status.set", statusSet);
  yield* supervisor.serveHostMethod("status.clear", statusClear);
});

export const layer = Layer.effectDiscard(make());
