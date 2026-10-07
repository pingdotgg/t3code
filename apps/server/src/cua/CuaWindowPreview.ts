import * as NodeModule from "node:module";

import type {
  CuaWindowPreviewFrame,
  CuaWindowPreviewState,
  OrchestrationV2DomainEvent,
  ThreadId,
} from "@t3tools/contracts";
import type * as CuaSdk from "@trycua/cua-driver";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  clearCuaWindowTarget,
  readCuaWindowTarget,
  type CuaWindowTarget,
} from "./cuaToolPresentation.ts";

export class CuaWindowPreviewSdkError extends Schema.TaggedError<CuaWindowPreviewSdkError>()(
  "CuaWindowPreviewSdkError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not load the Cua Driver SDK for window previews.";
  }
}

export class CuaWindowPreviewCaptureError extends Schema.TaggedError<CuaWindowPreviewCaptureError>()(
  "CuaWindowPreviewCaptureError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not capture the window the agent is driving.";
  }
}

export class CuaWindowPreview extends Context.Service<
  CuaWindowPreview,
  {
    /** Current state first, then every change while the subscriber stays attached. */
    readonly stream: (threadId: ThreadId) => Stream.Stream<CuaWindowPreviewState>;
  }
>()("t3/cua/CuaWindowPreview") {}

export type SdkModule = Pick<typeof CuaSdk, "CuaDriver" | "GetWindowStateInput">;
// `connect` is typed as the interface, but every implementation is the
// generated class with the native handle to release.
type SdkClient = Pick<CuaSdk.CuaDriver, "getWindowState" | "shutdown" | "uniffiDestroy">;

const REFRESH_INTERVAL = Duration.millis(250);
/** Long edge of the preview frame; small enough for a floating card over the app WS. */
const MAX_DIMENSION = 800;
const IDLE_STATE: CuaWindowPreviewState = { status: "idle" };

const requireForCuaDriver = NodeModule.createRequire(import.meta.url);

/** Same resolution as the embedded host loader: the package only exports `import` conditions. */
const loadSdk = Effect.fn("CuaWindowPreview.loadSdk")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const lookupPath of requireForCuaDriver.resolve.paths("@trycua/cua-driver") ?? []) {
    const packageDir = path.join(lookupPath, "@trycua", "cua-driver");
    if (
      yield* fs
        .exists(path.join(packageDir, "package.json"))
        .pipe(Effect.orElseSucceed(() => false))
    ) {
      return yield* Effect.try({
        try: () => requireForCuaDriver(path.join(packageDir, "dist", "index.js")) as SdkModule,
        catch: (cause) => new CuaWindowPreviewSdkError({ cause }),
      });
    }
  }
  return yield* new CuaWindowPreviewSdkError({ cause: "@trycua/cua-driver is not installed." });
});

/** Captures only the selected window; desktop pixels cannot stand in for it. */
const captureFrame = Effect.fn("CuaWindowPreview.capture")(function* (
  sdk: SdkModule,
  client: SdkClient,
  target: CuaWindowTarget,
) {
  const capturedAt = DateTime.formatIso(yield* DateTime.now);
  const window = yield* Effect.tryPromise({
    try: (signal) =>
      client.getWindowState(
        sdk.GetWindowStateInput.new({
          pid: target.pid,
          windowId: target.windowId,
          includeAccessibilityTree: false,
          includeScreenshot: true,
          maxDimension: MAX_DIMENSION,
        }),
        { signal },
      ),
    catch: (cause) => new CuaWindowPreviewCaptureError({ cause }),
  });
  const image = window.images[0];
  if (!image) {
    return yield* new CuaWindowPreviewCaptureError({
      cause: "Window capture is unavailable.",
    });
  }
  return {
    ...(window.appName ? { appName: window.appName } : {}),
    ...(window.windowTitle ? { windowTitle: window.windowTitle } : {}),
    width: window.screenshotWidth ?? 0,
    height: window.screenshotHeight ?? 0,
    mimeType: image.mimeType,
    dataBase64: image.dataBase64,
    capturedAt,
  } satisfies CuaWindowPreviewFrame;
});

interface ThreadPreview {
  readonly changes: PubSub.PubSub<CuaWindowPreviewState>;
  state: CuaWindowPreviewState;
  subscribers: number;
  /** Set while the thread's provider session has a turn in flight with Cua attached. */
  live: boolean;
  loop: Scope.Closeable | undefined;
}

export interface CuaWindowPreviewOptions {
  /** Test seam: replaces the SDK load so the loop can run against a fake driver. */
  readonly loadSdk?: Effect.Effect<SdkModule, CuaWindowPreviewSdkError>;
  readonly refreshInterval?: Duration.Duration;
}

export const make = Effect.fn("CuaWindowPreview.make")(function* (
  options: CuaWindowPreviewOptions = {},
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const mutex = yield* Semaphore.make(1);
  const threads = new Map<ThreadId, ThreadPreview>();
  const refreshInterval = options.refreshInterval ?? REFRESH_INTERVAL;
  const loadSdkModule =
    options.loadSdk ??
    loadSdk().pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  let sdk: SdkModule | undefined;

  const publish = (preview: ThreadPreview, state: CuaWindowPreviewState) =>
    Effect.suspend(() => {
      preview.state = state;
      return PubSub.publish(preview.changes, state);
    });

  const previewFor = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const existing = threads.get(threadId);
      if (existing) return existing;
      const created: ThreadPreview = {
        changes: yield* PubSub.sliding<CuaWindowPreviewState>(2),
        state: IDLE_STATE,
        subscribers: 0,
        live: false,
        loop: undefined,
      };
      threads.set(threadId, created);
      return created;
    });

  /**
   * One capture loop per thread, running only while a client is subscribed
   * and the agent is mid-turn with Cua attached. The SDK client lives for the
   * loop; every stop releases the native handle.
   */
  const refreshLoop = (threadId: ThreadId, preview: ThreadPreview, socketPath: string) =>
    Effect.gen(function* () {
      sdk ??= yield* loadSdkModule;
      const module = sdk;
      const client = yield* Effect.acquireRelease(
        Effect.try({
          try: () => module.CuaDriver.connect(socketPath) as unknown as SdkClient,
          catch: (cause) => new CuaWindowPreviewSdkError({ cause }),
        }),
        (client) =>
          Effect.promise(() => client.shutdown()).pipe(
            Effect.ignore,
            Effect.andThen(Effect.sync(() => client.uniffiDestroy())),
          ),
      );
      const capture = Effect.suspend(() => {
        const target = readCuaWindowTarget(threadId);
        if (!target) return publish(preview, { status: "live" });
        const isCurrent = () => {
          const current = readCuaWindowTarget(threadId);
          return current?.pid === target?.pid && current?.windowId === target?.windowId;
        };
        return captureFrame(module, client, target).pipe(
          // Compositor transitions can briefly fail a frame. Keep the current
          // frame during bounded retries, but report persistent capture loss.
          Effect.retry({ times: 2, schedule: Schedule.spaced("150 millis"), while: isCurrent }),
          Effect.flatMap((frame) =>
            isCurrent() ? publish(preview, { status: "live", frame }) : Effect.void,
          ),
          Effect.catchTags({
            CuaWindowPreviewCaptureError: (error) =>
              isCurrent()
                ? publish(preview, {
                    status: "unavailable",
                    detail: typeof error.cause === "string" ? error.cause : error.message,
                  })
                : Effect.void,
          }),
        );
      });
      return yield* Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        yield* capture;
        const elapsed = Math.max(0, (yield* Clock.currentTimeMillis) - startedAt);
        // Cap at 4 FPS, with at least as much idle time as capture time.
        // Slow captures lower the rate instead of filling a queue or busy-looping.
        const minimumInterval = readCuaWindowTarget(threadId)
          ? Duration.toMillis(refreshInterval)
          : 1500;
        yield* Effect.sleep(Math.max(minimumInterval - elapsed, elapsed));
      }).pipe(Effect.forever);
    }).pipe(
      Effect.catch((error: CuaWindowPreviewSdkError) =>
        publish(preview, { status: "unavailable", detail: error.message }),
      ),
    );

  const reconcile = (threadId: ThreadId) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const preview = threads.get(threadId);
        if (!preview) return;
        const socketPath =
          McpProviderSession.readMcpProviderSession(threadId)?.cuaDriver?.socketPath;
        const shouldRun = preview.live && preview.subscribers > 0 && socketPath !== undefined;
        if (shouldRun && !preview.loop) {
          const loopScope = yield* Scope.fork(scope);
          preview.loop = loopScope;
          yield* refreshLoop(threadId, preview, socketPath).pipe(
            Effect.scoped,
            Effect.forkIn(loopScope),
          );
          return;
        }
        if (!shouldRun && preview.loop) {
          const loopScope = preview.loop;
          preview.loop = undefined;
          yield* Scope.close(loopScope, Exit.void);
          if (preview.subscribers === 0) {
            threads.delete(threadId);
          } else if (!preview.live) {
            yield* publish(preview, IDLE_STATE);
          }
        }
      }),
    );

  // A provider turn running on a thread with Cua attached makes it live; any
  // terminal status ends it.
  const onDomainEvent = (event: OrchestrationV2DomainEvent) =>
    Effect.gen(function* () {
      if (event.type !== "provider-turn.updated") return;
      const status = event.payload.status;
      if (status === "running") {
        const preview = yield* previewFor(event.threadId);
        preview.live =
          McpProviderSession.readMcpProviderSession(event.threadId)?.cuaDriver?.socketPath !==
          undefined;
        yield* reconcile(event.threadId);
      } else if (status !== "pending") {
        clearCuaWindowTarget(event.threadId);
        const preview = threads.get(event.threadId);
        if (!preview) return;
        preview.live = false;
        yield* reconcile(event.threadId);
      }
    });

  yield* orchestrator.streamDomainEvents.pipe(
    Stream.runForEach(onDomainEvent),
    Effect.catchCause((cause) =>
      Effect.logWarning("Computer use preview stopped following turns.", { cause }),
    ),
    Effect.forkScoped,
  );

  const stream = (threadId: ThreadId): Stream.Stream<CuaWindowPreviewState> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const preview = yield* previewFor(threadId);
        const subscription = yield* PubSub.subscribe(preview.changes);
        preview.subscribers += 1;
        yield* Effect.addFinalizer(() =>
          Effect.suspend(() => {
            preview.subscribers -= 1;
            return reconcile(threadId);
          }),
        );
        yield* reconcile(threadId);
        return Stream.concat(Stream.make(preview.state), Stream.fromSubscription(subscription));
      }),
    ).pipe(Stream.scoped);

  return CuaWindowPreview.of({ stream });
});

export const layer = Layer.effect(CuaWindowPreview, make());
