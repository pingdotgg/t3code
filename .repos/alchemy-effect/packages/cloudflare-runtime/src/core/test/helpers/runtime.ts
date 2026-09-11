import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Done } from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Docker from "../../Docker.ts";
import * as Globals from "../../globals/Globals.ts";
import * as Internet from "../../globals/Internet.ts";
import * as Storage from "../../globals/Storage.ts";
import * as Paths from "../../internal/Paths.ts";
import * as Runtime from "../../Runtime.ts";
import * as RuntimeServices from "../../RuntimeServices.ts";
import type { BindingHooks, RuntimeWorker } from "../../RuntimeWorker.ts";
import * as Registry from "../../registry/Registry.ts";
import * as RegistryProxy from "../../registry/RegistryProxy.ts";
import {
  type ResolvedTargetMap,
  resolvedTargetKey,
  type Subscriber,
} from "../../registry/RegistryTypes.shared.ts";
import * as Workerd from "../../workerd/Workerd.ts";

export const configProvider = (
  input: { fileSystemSupportsWatcher?: boolean } = {},
) =>
  ConfigProvider.layer(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return ConfigProvider.fromUnknown({
        CLOUDFLARE_RUNTIME_HOME: yield* fs.makeTempDirectoryScoped({
          prefix: "cloudflare-runtime-test",
        }),
        CLOUDFLARE_RUNTIME_FILE_SYSTEM_SUPPORTS_WATCHER:
          input.fileSystemSupportsWatcher,
      });
    }),
  );

/**
 * A `Runtime` layer suitable for local-only tests.
 *
 * Excludes `RemoteBindings` so the tests don't require Cloudflare API
 * credentials. Workers configured here may use any local binding (Json,
 * Text, Data, KvNamespace local, Loopback, DurableObjectNamespace, etc.)
 * but **must not** register a remote binding — that would attempt to
 * deploy a preview script and fail without credentials.
 */
export const localRuntimeLayer = Runtime.RuntimeLive.pipe(
  Layer.provideMerge(RuntimeServices.layerLocalBindings()),
  Layer.provideMerge(RuntimeServices.layerProxy()),
  Layer.provide(Globals.GlobalsLive),
  Layer.provideMerge(RuntimeServices.layerLoopback()),
  Layer.provide(
    Layer.effect(
      Storage.Storage,
      Effect.suspend(() => makeTempDirectory()).pipe(Effect.map(Storage.make)),
    ),
  ),
  Layer.provide(Internet.InternetLive),
  Layer.provideMerge(RegistryProxy.RegistryProxyLive),
  Layer.provideMerge(Registry.RegistryLive),
  Layer.provideMerge(Paths.PathsLive),
  Layer.provideMerge(Docker.DockerLive),
  Layer.provide(Workerd.WorkerdLive),
  Layer.provide(configProvider()),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);

export interface TestWorker {
  baseUrl: URL;
  fetch: (path: string, init?: RequestInit) => Effect.Effect<Response>;
  fetchText: (path: string, init?: RequestInit) => Effect.Effect<string>;
  fetchJson: <T>(path: string, init?: RequestInit) => Effect.Effect<T>;
}

/**
 * Start a worker via the `Runtime` and return helpers bound to its base URL.
 *
 * The returned `fetch` accepts a path or full URL; relative paths are
 * resolved against the worker's base URL.
 */
export const startTestWorker = <B extends BindingHooks>(
  worker: RuntimeWorker<B>,
) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime;
    const baseUrl = yield* runtime.start(worker);
    const fetch = (path: string, init?: RequestInit) =>
      Effect.promise(() => globalThis.fetch(new URL(path, baseUrl), init));
    const fetchText = (path: string, init?: RequestInit) =>
      fetch(path, init).pipe(
        Effect.flatMap((res) => Effect.promise(() => res.text())),
      );
    const fetchJson = <T>(path: string, init?: RequestInit) =>
      fetch(path, init).pipe(
        Effect.flatMap((res) => Effect.promise(() => res.json() as Promise<T>)),
      );
    return { baseUrl, fetch, fetchText, fetchJson } satisfies TestWorker;
  });

export const waitForRegistryEntry = Effect.fn(function* (
  subscriber: Subscriber,
  options: { toBeDefined: boolean } = { toBeDefined: true },
) {
  const registry = yield* Registry.Registry;
  const queue = yield* Queue.unbounded<ResolvedTargetMap, Done<void>>();
  yield* registry
    .subscribe([subscriber])
    .pipe(Stream.runIntoQueue(queue), Effect.forkScoped);
  while (true) {
    const value = yield* Queue.take(queue);
    const isDefined = resolvedTargetKey(subscriber) in value;
    if (isDefined === options.toBeDefined) {
      return;
    }
  }
}, Effect.scoped);

export class PredicateFailed extends Data.TaggedError("PredicateFailed")<{
  value: unknown;
}> {}

export const poll = <T>(
  worker: TestWorker,
  path: string,
  predicate: (value: T) => boolean,
  timeout: number = 10_000,
) =>
  worker.fetchJson<T>(path).pipe(
    Effect.flatMap((value) =>
      predicate(value)
        ? Effect.succeed(value)
        : Effect.fail(new PredicateFailed({ value: value })),
    ),
    Effect.retry({
      while: (error) => error._tag === "PredicateFailed",
      schedule: Schedule.spaced("50 millis"),
      times: timeout / 50,
    }),
  );

/**
 * A real-timer delay that resolves after `millis`. Unlike `Effect.sleep`, it
 * does not depend on the Effect `Clock`, so it still advances under a
 * `TestClock` (test suites here run with the default `TestEnv`).
 */
const realDelay = (millis: number) =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), millis);
    return Effect.sync(() => clearTimeout(timer));
  });

/**
 * `makeTempDirectoryScoped` fails on Windows in CI with "EBUSY: resource busy
 * or locked": a just-terminated `workerd` process can still hold handles to
 * files under the directory for a short while after it is killed. This is a
 * drop-in replacement that retries the removal on a real timer until the
 * handles are released.
 */
export const makeTempDirectory = Effect.fn(function* (prefix?: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectory({ prefix });
  const remove = (attempt: number): Effect.Effect<void> =>
    fs.remove(dir, { recursive: true, force: true }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "Busy" && attempt < 50,
        () => realDelay(100).pipe(Effect.andThen(remove(attempt + 1))),
      ),
      Effect.orDie,
    );
  yield* Effect.addFinalizer(() => remove(0));
  return dir;
});
