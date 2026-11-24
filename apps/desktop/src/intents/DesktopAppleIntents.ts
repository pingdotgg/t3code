import type {
  AppleIntentAuthCredential,
  AppleIntentIndexDelta,
  AppleIntentOnscreenContext,
  AppleIntentStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class DesktopAppleIntentsNativeError extends Schema.TaggedError<DesktopAppleIntentsNativeError>()(
  "DesktopAppleIntentsNativeError",
  { operation: Schema.String, status: Schema.Number },
) {
  override get message(): string {
    return `Apple Intents ${this.operation} failed with native status ${this.status}.`;
  }
}

/** Each mutation returns the native status code: 0 on success. */
interface AppleIntentsNativeBinding {
  readonly isSupported: () => boolean;
  readonly bootstrap: () => void;
  readonly syncIndex: (json: string) => Promise<number>;
  readonly removeEnvironment: (environmentId: string) => Promise<number>;
  readonly clearIndex: () => Promise<number>;
  readonly setOnscreenContext: (json: string) => number;
  readonly syncAuthCredentials: (json: string) => number;
  readonly resolveSpotlightUrl: (identifier: string) => string | null;
}

const FFI_LIBRARY_KEY = "t3-apple-intents-host";

let nativeBindingPromise: Promise<AppleIntentsNativeBinding | null> | undefined;

async function loadNativeBinding(dylibPath: string): Promise<AppleIntentsNativeBinding | null> {
  try {
    const {
      DataType,
      PointerType,
      freePointer,
      isNullPointer,
      load,
      open,
      restorePointer,
      wrapPointer,
    } = await import("ffi-rs");
    open({ library: FFI_LIBRARY_KEY, path: dylibPath });

    const callVoid = (funcName: string): number =>
      load({
        library: FFI_LIBRARY_KEY,
        funcName,
        retType: DataType.I32,
        paramsType: [],
        paramsValue: [],
      });

    const callString = (funcName: string, value: string): number =>
      load({
        library: FFI_LIBRARY_KEY,
        funcName,
        retType: DataType.I32,
        paramsType: [DataType.String],
        paramsValue: [value],
      });

    // These exports block until Spotlight finishes, so they run off the Electron main thread.
    const callInWorker = (funcName: string, params: ReadonlyArray<string>): Promise<number> =>
      load({
        library: FFI_LIBRARY_KEY,
        funcName,
        retType: DataType.I32,
        paramsType: params.map(() => DataType.String),
        paramsValue: [...params],
        runInNewThread: true,
      });

    const binding: AppleIntentsNativeBinding = {
      isSupported: () => callVoid("t3_apple_intents_is_supported") === 1,
      bootstrap: () => {
        callVoid("t3_apple_intents_bootstrap");
      },
      syncIndex: (json) => callInWorker("t3_apple_intents_sync_index", [json]),
      removeEnvironment: (environmentId) =>
        callInWorker("t3_apple_intents_remove_environment", [environmentId]),
      clearIndex: () => callInWorker("t3_apple_intents_clear_index", []),
      setOnscreenContext: (json) => callString("t3_apple_intents_set_onscreen_context", json),
      syncAuthCredentials: (json) => callString("t3_apple_intents_sync_auth_credentials", json),
      resolveSpotlightUrl: (identifier) => {
        const ptr = load({
          library: FFI_LIBRARY_KEY,
          funcName: "t3_apple_intents_resolve_spotlight_url",
          retType: DataType.External,
          paramsType: [DataType.String],
          paramsValue: [identifier],
        });
        // A null `char *` still arrives as an External, so `!ptr` cannot detect it.
        if (isNullPointer(ptr)) return null;
        const wrapped = wrapPointer([ptr]);
        try {
          const restored = restorePointer({
            retType: [DataType.String],
            paramsValue: wrapped,
          }) as ReadonlyArray<unknown>;
          const value = restored[0];
          return typeof value === "string" && value.length > 0 ? value : null;
        } finally {
          // The wrapper is ffi-rs's own allocation; the string itself was strdup'd by the dylib.
          freePointer({
            paramsType: [DataType.External],
            paramsValue: wrapped,
            pointerType: PointerType.RsPointer,
          });
          load({
            library: FFI_LIBRARY_KEY,
            funcName: "t3_apple_intents_free_string",
            retType: DataType.Void,
            paramsType: [DataType.External],
            paramsValue: [ptr],
          });
        }
      },
    };

    binding.bootstrap();
    return binding;
  } catch {
    return null;
  }
}

type DesktopAppleIntentsMutation<A = void> = Effect.Effect<A, DesktopAppleIntentsNativeError>;

export class DesktopAppleIntents extends Context.Service<
  DesktopAppleIntents,
  {
    readonly getStatus: Effect.Effect<AppleIntentStatus>;
    readonly syncIndex: (delta: AppleIntentIndexDelta) => DesktopAppleIntentsMutation;
    readonly removeEnvironment: (environmentId: EnvironmentId) => DesktopAppleIntentsMutation;
    readonly clearIndex: DesktopAppleIntentsMutation;
    readonly setOnscreenContext: (
      context: AppleIntentOnscreenContext,
    ) => DesktopAppleIntentsMutation;
    readonly syncAuthCredentials: (
      credentials: ReadonlyArray<AppleIntentAuthCredential>,
    ) => DesktopAppleIntentsMutation;
    readonly resolveSpotlightUrl: (identifier: string) => Effect.Effect<string | null>;
  }
>()("@t3tools/desktop/intents/DesktopAppleIntents") {}

const NATIVE_TIMEOUT_STATUS = -2;
const NATIVE_MUTATION_TIMEOUT = "30 seconds";

const checkNativeStatus = (operation: string, status: number): DesktopAppleIntentsMutation =>
  status === 0
    ? Effect.void
    : Effect.fail(new DesktopAppleIntentsNativeError({ operation, status }));

// A failure keeps the renderer's sync baseline where it was, so the next flush retries.
const runNative = (operation: string, call: () => number): DesktopAppleIntentsMutation =>
  Effect.sync(call).pipe(Effect.flatMap((status) => checkNativeStatus(operation, status)));

const runNativeInWorker = (
  operation: string,
  call: () => Promise<number>,
): DesktopAppleIntentsMutation =>
  Effect.tryPromise({
    try: call,
    catch: () => new DesktopAppleIntentsNativeError({ operation, status: -1 }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: NATIVE_MUTATION_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new DesktopAppleIntentsNativeError({ operation, status: NATIVE_TIMEOUT_STATUS }),
        ),
    }),
    Effect.flatMap((status) => checkNativeStatus(operation, status)),
  );

const encodeNativeJson = (operation: string, value: unknown) =>
  encodeJsonString(value).pipe(
    Effect.mapError(() => new DesktopAppleIntentsNativeError({ operation, status: -1 })),
  );

export const layer = Layer.effect(
  DesktopAppleIntents,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;

    let dylibPath: string | undefined;
    if (environment.platform === "darwin") {
      const candidate = environment.isPackaged
        ? environment.path.join(
            environment.resourcesPath,
            "apple-intents",
            "libT3AppIntentsHost.dylib",
          )
        : environment.path.join(
            environment.rootDir,
            "native",
            "apple-intents",
            "macos",
            "build",
            environment.processArch,
            "host",
            "libT3AppIntentsHost.dylib",
          );
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        dylibPath = candidate;
      }
    }

    const resolveBinding = Effect.suspend(() => {
      if (dylibPath === undefined) return Effect.succeed<AppleIntentsNativeBinding | null>(null);
      const targetPath = dylibPath;
      return Effect.promise(() => (nativeBindingPromise ??= loadNativeBinding(targetPath))).pipe(
        Effect.orElseSucceed(() => null),
      );
    });
    const supportedBinding = resolveBinding.pipe(
      Effect.map((binding) => (binding?.isSupported() ? binding : null)),
    );

    return DesktopAppleIntents.of({
      getStatus: Effect.gen(function* () {
        if (environment.platform !== "darwin") {
          return { available: false, reason: "unsupported-platform" };
        }
        const binding = yield* resolveBinding;
        if (!binding) {
          return { available: false, reason: "native-bridge-unavailable" };
        }
        return binding.isSupported()
          ? { available: true }
          : { available: false, reason: "requires-macos-27.3" };
      }),
      syncIndex: Effect.fn("DesktopAppleIntents.syncIndex")(function* (delta) {
        const binding = yield* supportedBinding;
        if (!binding) return;
        const json = yield* encodeNativeJson("syncIndex", delta);
        yield* runNativeInWorker("syncIndex", () => binding.syncIndex(json));
      }),
      removeEnvironment: Effect.fn("DesktopAppleIntents.removeEnvironment")(
        function* (environmentId) {
          const binding = yield* supportedBinding;
          if (!binding) return;
          yield* runNativeInWorker("removeEnvironment", () =>
            binding.removeEnvironment(environmentId),
          );
        },
      ),
      clearIndex: Effect.gen(function* () {
        const binding = yield* supportedBinding;
        if (!binding) return;
        yield* runNativeInWorker("clearIndex", () => binding.clearIndex());
      }),
      setOnscreenContext: Effect.fn("DesktopAppleIntents.setOnscreenContext")(function* (context) {
        const binding = yield* supportedBinding;
        if (!binding) return;
        const json = context === null ? "" : yield* encodeNativeJson("setOnscreenContext", context);
        yield* runNative("setOnscreenContext", () => binding.setOnscreenContext(json));
      }),
      syncAuthCredentials: Effect.fn("DesktopAppleIntents.syncAuthCredentials")(
        function* (credentials) {
          const binding = yield* supportedBinding;
          if (!binding) return;
          const json = yield* encodeNativeJson("syncAuthCredentials", credentials);
          yield* runNative("syncAuthCredentials", () => binding.syncAuthCredentials(json));
        },
      ),
      resolveSpotlightUrl: Effect.fn("DesktopAppleIntents.resolveSpotlightUrl")(
        function* (identifier) {
          const binding = yield* resolveBinding;
          if (!binding) return null;
          return yield* Effect.sync(() => binding.resolveSpotlightUrl(identifier));
        },
      ),
    });
  }),
);
