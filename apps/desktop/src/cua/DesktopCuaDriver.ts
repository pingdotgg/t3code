import type { CuaDriverMcpConfiguration } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type { EmbeddedCuaDriverHost, EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

export const T3CODE_CUA_DRIVER_PATH_ENV = "T3CODE_CUA_DRIVER_PATH";

export class CuaDriverNotConfiguredError extends Schema.TaggedErrorClass<CuaDriverNotConfiguredError>()(
  "CuaDriverNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Cua Driver is not configured.";
  }
}

export class CuaDriverModuleLoadError extends Schema.TaggedErrorClass<CuaDriverModuleLoadError>()(
  "CuaDriverModuleLoadError",
  {
    modulePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not load Cua Driver module '${this.modulePath}'.`;
  }
}

export class CuaDriverPermissionError extends Schema.TaggedErrorClass<CuaDriverPermissionError>()(
  "CuaDriverPermissionError",
  {
    accessibility: Schema.Boolean,
    screenRecording: Schema.Boolean,
  },
) {
  override get message(): string {
    return "T3 Code needs Accessibility and Screen Recording access before Cua Driver can start.";
  }
}

export class CuaDriverStartError extends Schema.TaggedErrorClass<CuaDriverStartError>()(
  "CuaDriverStartError",
  {
    binaryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not start embedded cua-driver at '${this.binaryPath}'.`;
  }
}

type DesktopCuaDriverError =
  | CuaDriverNotConfiguredError
  | CuaDriverModuleLoadError
  | CuaDriverPermissionError
  | CuaDriverStartError;

interface HostedDriver {
  readonly host: EmbeddedCuaDriverHost;
  readonly connection: EmbeddedDriverConnection;
}

export interface DesktopCuaDriverDependencies {
  readonly loadEmbedded: () => Promise<typeof import("@trycua/cua-driver/embedded")>;
  readonly loadElectron: () => Promise<typeof import("@trycua/cua-driver/electron")>;
}

const defaultDependencies: DesktopCuaDriverDependencies = {
  loadEmbedded: () => import("@trycua/cua-driver/embedded"),
  loadElectron: () => import("@trycua/cua-driver/electron"),
};

export const resolveEmbeddedDriverPath = (
  environment: NodeJS.ProcessEnv,
  desktop: Pick<
    DesktopEnvironment.DesktopEnvironment["Service"],
    "isPackaged" | "platform" | "resourcesPath" | "path"
  >,
): Option.Option<string> => {
  if (desktop.isPackaged) {
    return Option.some(
      desktop.platform === "darwin"
        ? desktop.path.join(desktop.resourcesPath, "cua-driver")
        : desktop.path.join(
            desktop.resourcesPath,
            "cua-driver",
            desktop.platform === "win32" ? "cua-driver.exe" : "cua-driver",
          ),
    );
  }

  return Option.fromNullishOr(environment[T3CODE_CUA_DRIVER_PATH_ENV]).pipe(
    Option.map((value) => value.trim()),
    Option.filter((value) => value.length > 0),
  );
};

export class DesktopCuaDriver extends Context.Service<
  DesktopCuaDriver,
  {
    readonly start: Effect.Effect<CuaDriverMcpConfiguration, DesktopCuaDriverError, Scope.Scope>;
    readonly stop: Effect.Effect<void>;
    readonly mcpConfiguration: Effect.Effect<Option.Option<CuaDriverMcpConfiguration>>;
  }
>()("@t3tools/desktop/cua/DesktopCuaDriver") {}

const destroyHost = (host: EmbeddedCuaDriverHost) =>
  Effect.sync(() => host.uniffiDestroy()).pipe(Effect.catchCause(() => Effect.void));

export const make = Effect.fn("desktop.cuaDriver.make")(function* (
  dependencies: DesktopCuaDriverDependencies = defaultDependencies,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const state = yield* Ref.make(Option.none<HostedDriver>());

  const stop = Ref.getAndSet(state, Option.none()).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: ({ host }) =>
          Effect.tryPromise(() => host.stop()).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("embedded cua-driver failed to stop cleanly", {
                component: "embedded-cua-driver",
                cause,
              }),
            ),
            Effect.ensuring(destroyHost(host)),
          ),
      }),
    ),
  );

  const start = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    if (Option.isSome(current)) return current.value.connection.mcp;

    const binaryPath = resolveEmbeddedDriverPath(process.env, environment);
    if (Option.isNone(binaryPath)) return yield* new CuaDriverNotConfiguredError();

    if (environment.platform === "darwin") {
      const electronHelpers = yield* Effect.tryPromise({
        try: dependencies.loadElectron,
        catch: (cause) =>
          new CuaDriverModuleLoadError({
            modulePath: "@trycua/cua-driver/electron",
            cause,
          }),
      });
      const permissionStatus = electronHelpers.requestMacOSPermissions();
      if (!electronHelpers.hasRequiredMacOSPermissions(permissionStatus)) {
        return yield* new CuaDriverPermissionError(permissionStatus);
      }
    }

    const { EmbeddedCuaDriverHost } = yield* Effect.tryPromise({
      try: dependencies.loadEmbedded,
      catch: (cause) =>
        new CuaDriverModuleLoadError({
          modulePath: "@trycua/cua-driver/embedded",
          cause,
        }),
    });
    const host = yield* Effect.try({
      try: () => new EmbeddedCuaDriverHost(binaryPath.value, environment.appUserModelId),
      catch: (cause) => new CuaDriverStartError({ binaryPath: binaryPath.value, cause }),
    });
    const connection = yield* Effect.tryPromise({
      try: () => host.start(),
      catch: (cause) => new CuaDriverStartError({ binaryPath: binaryPath.value, cause }),
    }).pipe(Effect.tapError(() => destroyHost(host)));
    yield* Ref.set(state, Option.some({ host, connection }));

    yield* Effect.tryPromise(() => host.waitForExit(connection.generation)).pipe(
      Effect.flatMap((exit) =>
        Ref.modify(state, (active) => {
          if (Option.isNone(active) || active.value.connection.generation !== exit.generation) {
            return [false, active] as const;
          }
          return [true, Option.none()] as const;
        }).pipe(
          Effect.flatMap((unexpected) =>
            unexpected
              ? Effect.logWarning("embedded cua-driver exited; computer use is unavailable", {
                  component: "embedded-cua-driver",
                  generation: exit.generation,
                  code: exit.code,
                  success: exit.success,
                }).pipe(Effect.ensuring(destroyHost(host)))
              : Effect.void,
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Ref.modify(state, (active) => {
          if (
            Option.isNone(active) ||
            active.value.connection.generation !== connection.generation
          ) {
            return [false, active] as const;
          }
          return [true, Option.none()] as const;
        }).pipe(
          Effect.flatMap((unexpected) =>
            unexpected
              ? Effect.logWarning(
                  "embedded cua-driver exit monitor failed; computer use is unavailable",
                  { component: "embedded-cua-driver", cause },
                ).pipe(Effect.ensuring(destroyHost(host)))
              : Effect.void,
          ),
        ),
      ),
      Effect.forkScoped,
    );

    yield* Effect.logInfo("embedded cua-driver ready", {
      component: "embedded-cua-driver",
      pid: connection.pid,
      socketPath: connection.socketPath,
    });
    return connection.mcp;
  });

  return DesktopCuaDriver.of({
    start,
    stop,
    mcpConfiguration: Ref.get(state).pipe(
      Effect.map(Option.map(({ connection }) => connection.mcp)),
    ),
  });
});

export const layer = Layer.effect(DesktopCuaDriver, make());
