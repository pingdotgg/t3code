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

interface AppleIntentsNativeBinding {
  readonly isSupported: () => boolean;
  readonly bootstrap: () => void;
  readonly syncIndex: (json: string) => void;
  readonly removeEnvironment: (environmentId: string) => void;
  readonly clearIndex: () => void;
  readonly setOnscreenContext: (json: string) => void;
  readonly syncAuthCredentials: (json: string) => void;
  readonly resolveSpotlightUrl: (identifier: string) => string | null;
}

const FFI_LIBRARY_KEY = "t3-apple-intents-host";

let nativeBindingPromise: Promise<AppleIntentsNativeBinding | null> | undefined;

async function loadNativeBinding(dylibPath: string): Promise<AppleIntentsNativeBinding | null> {
  try {
    const { DataType, load, open, restorePointer } = await import("ffi-rs");
    open({ library: FFI_LIBRARY_KEY, path: dylibPath });

    const callVoid = (funcName: string) =>
      load({
        library: FFI_LIBRARY_KEY,
        funcName,
        retType: DataType.I32,
        paramsType: [],
        paramsValue: [],
      });

    const callString = (funcName: string, value: string) =>
      load({
        library: FFI_LIBRARY_KEY,
        funcName,
        retType: DataType.I32,
        paramsType: [DataType.String],
        paramsValue: [value],
      });

    const binding: AppleIntentsNativeBinding = {
      isSupported: () => callVoid("t3_apple_intents_is_supported") === 1,
      bootstrap: () => {
        callVoid("t3_apple_intents_bootstrap");
      },
      syncIndex: (json) => {
        callString("t3_apple_intents_sync_index", json);
      },
      removeEnvironment: (environmentId) => {
        callString("t3_apple_intents_remove_environment", environmentId);
      },
      clearIndex: () => {
        callVoid("t3_apple_intents_clear_index");
      },
      setOnscreenContext: (json) => {
        callString("t3_apple_intents_set_onscreen_context", json);
      },
      syncAuthCredentials: (json) => {
        callString("t3_apple_intents_sync_auth_credentials", json);
      },
      resolveSpotlightUrl: (identifier) => {
        const ptr = load({
          library: FFI_LIBRARY_KEY,
          funcName: "t3_apple_intents_resolve_spotlight_url",
          retType: DataType.External,
          paramsType: [DataType.String],
          paramsValue: [identifier],
        });
        if (!ptr) return null;
        try {
          const restored = restorePointer({
            retType: [DataType.String],
            paramsValue: [ptr],
          }) as ReadonlyArray<unknown>;
          const value = restored[0];
          return typeof value === "string" && value.length > 0 ? value : null;
        } finally {
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

export class DesktopAppleIntents extends Context.Service<
  DesktopAppleIntents,
  {
    readonly getStatus: Effect.Effect<AppleIntentStatus>;
    readonly syncIndex: (delta: AppleIntentIndexDelta) => Effect.Effect<void>;
    readonly removeEnvironment: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly clearIndex: Effect.Effect<void>;
    readonly setOnscreenContext: (context: AppleIntentOnscreenContext) => Effect.Effect<void>;
    readonly syncAuthCredentials: (
      credentials: ReadonlyArray<AppleIntentAuthCredential>,
    ) => Effect.Effect<void>;
    readonly resolveSpotlightUrl: (identifier: string) => Effect.Effect<string | null>;
  }
>()("@t3tools/desktop/intents/DesktopAppleIntents") {}

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
        const binding = yield* resolveBinding;
        if (!binding || !binding.isSupported()) return;
        const json = yield* encodeJsonString(delta).pipe(Effect.orElseSucceed(() => ""));
        if (json.length === 0) return;
        yield* Effect.sync(() => {
          binding.syncIndex(json);
        });
      }),
      removeEnvironment: Effect.fn("DesktopAppleIntents.removeEnvironment")(
        function* (environmentId) {
          const binding = yield* resolveBinding;
          if (!binding || !binding.isSupported()) return;
          yield* Effect.sync(() => {
            binding.removeEnvironment(environmentId);
          });
        },
      ),
      clearIndex: Effect.gen(function* () {
        const binding = yield* resolveBinding;
        if (!binding || !binding.isSupported()) return;
        yield* Effect.sync(() => {
          binding.clearIndex();
        });
      }),
      setOnscreenContext: Effect.fn("DesktopAppleIntents.setOnscreenContext")(function* (context) {
        const binding = yield* resolveBinding;
        if (!binding || !binding.isSupported()) return;
        const json =
          context === null
            ? ""
            : yield* encodeJsonString(context).pipe(Effect.orElseSucceed(() => ""));
        yield* Effect.sync(() => {
          binding.setOnscreenContext(json);
        });
      }),
      syncAuthCredentials: Effect.fn("DesktopAppleIntents.syncAuthCredentials")(
        function* (credentials) {
          const binding = yield* resolveBinding;
          if (!binding || !binding.isSupported()) return;
          const json = yield* encodeJsonString(credentials).pipe(Effect.orElseSucceed(() => ""));
          if (json.length === 0) return;
          yield* Effect.sync(() => {
            binding.syncAuthCredentials(json);
          });
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
