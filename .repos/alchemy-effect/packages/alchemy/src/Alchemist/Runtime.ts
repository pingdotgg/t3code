import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";
import type { PlatformError } from "effect/PlatformError";
import { type AlchemyContext, AlchemyContextLive } from "../AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "../Artifacts.ts";
import { type CredentialsStore, CredentialsStoreLive } from "../Auth/Credentials.ts";
import { type ProfileStore, ProfileStoreLive } from "../Auth/Profile.ts";
import * as Interaction from "../Interaction.ts";
import { makePlainConsoleSink } from "../Util/ConsoleSink.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";
import { authRegistryLayer } from "./AuthRegistry.ts";

/** The services {@link layer} provides; every Alchemist operation runs under them. */
export type Services =
  | AlchemyContext
  | ArtifactStore
  | CredentialsStore
  | HttpClient
  | Interaction.Interaction
  | ProfileStore
  | PlatformServices;

/**
 * Log lines on the console. The caller's own loggers stay; only Effect's
 * default console logger gives way to this sink, so lines print once. Typed
 * events are left to `onEvent` subscribers (a renderer, or the caller's own
 * handler).
 *
 * Info and above only: records replayed from sidecars and child processes
 * bypass the fiber's minimum level, so the sink applies its own.
 */
const consoleSink = makePlainConsoleSink();
const ConsoleLog = Layer.unwrap(
  Effect.map(Logger.CurrentLoggers, (current) =>
    Logger.layer([
      ...[...current].filter((logger) => logger !== Logger.defaultLogger),
      Logger.make<unknown, void>((options) => {
        if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, "Info")) consoleSink.log(options);
      }),
    ]),
  ),
);

/**
 * All services required by the programmatic Alchemist API.
 *
 * Log lines print on the console. Typed events are log records too; observe
 * them around a call with {@link import("../Events.ts").onEvent}.
 * The non-interactive Interaction default serves the engine paths that need
 * one (state-store confirms fail typed; profile probes never prompt).
 *
 * @example
 * ```ts
 * Effect.runPromise(
 *   program.pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
 * )
 * ```
 */
export const layer = (): Layer.Layer<Services, PlatformError> =>
  Layer.mergeAll(
    Layer.mergeAll(AlchemyContextLive, ProfileStoreLive, CredentialsStoreLive).pipe(
      Layer.provideMerge(PlatformServices),
    ),
    FetchHttpClient.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv()),
    Layer.succeed(ArtifactStore, createArtifactStore()),
    Interaction.layerNonInteractive(),
    ConsoleLog,
    authRegistryLayer,
  );
