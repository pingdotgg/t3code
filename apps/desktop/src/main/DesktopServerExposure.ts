import type {
  AdvertisedEndpoint,
  DesktopServerExposureMode,
  DesktopServerExposureState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  DEFAULT_DESKTOP_SETTINGS,
  type DesktopSettings,
  setDesktopServerExposurePreference,
  setDesktopTailscaleServePreference,
} from "../desktopSettings.ts";
import * as DesktopEnvironment from "../desktopEnvironment.ts";
import * as DesktopNetwork from "../desktopNetworkInterfaces.ts";
import {
  DESKTOP_LOOPBACK_HOST,
  resolveDesktopCoreAdvertisedEndpoints,
  resolveDesktopServerExposure,
  type DesktopNetworkInterfaces,
  type DesktopServerExposure as ResolvedDesktopServerExposure,
} from "../serverExposure.ts";
import { resolveTailscaleAdvertisedEndpoints } from "../tailscaleEndpointProvider.ts";
import * as DesktopSettingsState from "./DesktopSettingsState.ts";

export { DESKTOP_LOOPBACK_HOST } from "../serverExposure.ts";
export const DESKTOP_REQUIRED_PORT_PROBE_HOSTS = ["0.0.0.0", "::"] as const;

type DesktopServerExposurePersistenceOperation = "server-exposure-mode" | "tailscale-serve";

export class DesktopServerExposureNoNetworkAddressError extends Data.TaggedError(
  "DesktopServerExposureNoNetworkAddressError",
)<{
  readonly port: number;
}> {
  override get message() {
    return `No reachable network address is available for desktop network access on port ${this.port}.`;
  }
}

export class DesktopServerExposurePersistenceError extends Data.TaggedError(
  "DesktopServerExposurePersistenceError",
)<{
  readonly operation: DesktopServerExposurePersistenceOperation;
  readonly cause: DesktopSettingsState.DesktopSettingsPersistenceError;
}> {
  override get message() {
    return `Failed to persist desktop ${this.operation} settings.`;
  }
}

export type DesktopServerExposureSetModeError =
  | DesktopServerExposureNoNetworkAddressError
  | DesktopServerExposurePersistenceError;

export type DesktopServerExposureError = DesktopServerExposureSetModeError;

export interface DesktopServerExposureBackendConfig {
  readonly port: number;
  readonly bindHost: string;
  readonly httpBaseUrl: URL;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
}

export interface DesktopServerExposureChange {
  readonly state: DesktopServerExposureState;
  readonly requiresRelaunch: boolean;
}

export interface DesktopServerExposureShape {
  readonly getState: Effect.Effect<DesktopServerExposureState>;
  readonly backendConfig: Effect.Effect<DesktopServerExposureBackendConfig>;
  readonly configureFromSettings: (input: {
    readonly port: number;
  }) => Effect.Effect<DesktopServerExposureState>;
  readonly setMode: (
    mode: DesktopServerExposureMode,
  ) => Effect.Effect<DesktopServerExposureChange, DesktopServerExposureSetModeError>;
  readonly setTailscaleServeEnabled: (input: {
    readonly enabled: boolean;
    readonly port?: number;
  }) => Effect.Effect<DesktopServerExposureChange, DesktopServerExposurePersistenceError>;
  readonly getAdvertisedEndpoints: Effect.Effect<readonly AdvertisedEndpoint[]>;
}

export class DesktopServerExposure extends Context.Service<
  DesktopServerExposure,
  DesktopServerExposureShape
>()("t3/desktop/ServerExposure") {}

interface RuntimeState {
  readonly requestedMode: DesktopServerExposureMode;
  readonly mode: DesktopServerExposureMode;
  readonly port: number;
  readonly bindHost: string;
  readonly localHttpUrl: string;
  readonly localWsUrl: string;
  readonly httpBaseUrl: URL;
  readonly endpointUrl: Option.Option<string>;
  readonly advertisedHost: Option.Option<string>;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
}

interface ResolvedRuntimeState {
  readonly state: RuntimeState;
  readonly unavailable: boolean;
}

const initialRuntimeState = (): RuntimeState =>
  runtimeStateFromResolvedExposure({
    requestedMode: DEFAULT_DESKTOP_SETTINGS.serverExposureMode,
    settings: DEFAULT_DESKTOP_SETTINGS,
    exposure: resolveDesktopServerExposure({
      mode: DEFAULT_DESKTOP_SETTINGS.serverExposureMode,
      port: 0,
      networkInterfaces: {},
    }),
    port: 0,
  });

const toContractState = (state: RuntimeState): DesktopServerExposureState => ({
  mode: state.mode,
  endpointUrl: Option.getOrNull(state.endpointUrl),
  advertisedHost: Option.getOrNull(state.advertisedHost),
  tailscaleServeEnabled: state.tailscaleServeEnabled,
  tailscaleServePort: state.tailscaleServePort,
});

const toBackendConfig = (state: RuntimeState): DesktopServerExposureBackendConfig => ({
  port: state.port,
  bindHost: state.bindHost,
  httpBaseUrl: state.httpBaseUrl,
  tailscaleServeEnabled: state.tailscaleServeEnabled,
  tailscaleServePort: state.tailscaleServePort,
});

const toResolvedExposure = (state: RuntimeState): ResolvedDesktopServerExposure => ({
  mode: state.mode,
  bindHost: state.bindHost,
  localHttpUrl: state.localHttpUrl,
  localWsUrl: state.localWsUrl,
  endpointUrl: Option.getOrNull(state.endpointUrl),
  advertisedHost: Option.getOrNull(state.advertisedHost),
});

const resolveAdvertisedHostOverride = (): Option.Option<string> => {
  const override = process.env.T3CODE_DESKTOP_LAN_HOST?.trim();
  return override && override.length > 0 ? Option.some(override) : Option.none();
};

const resolveCustomHttpsEndpointUrls = (): readonly string[] =>
  (process.env.T3CODE_DESKTOP_HTTPS_ENDPOINTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

function runtimeStateFromResolvedExposure(input: {
  readonly requestedMode: DesktopServerExposureMode;
  readonly settings: DesktopSettings;
  readonly exposure: ResolvedDesktopServerExposure;
  readonly port: number;
}): RuntimeState {
  return {
    requestedMode: input.requestedMode,
    mode: input.exposure.mode,
    port: input.port,
    bindHost: input.exposure.bindHost,
    localHttpUrl: input.exposure.localHttpUrl,
    localWsUrl: input.exposure.localWsUrl,
    httpBaseUrl: new URL(input.exposure.localHttpUrl),
    endpointUrl: Option.fromNullishOr(input.exposure.endpointUrl),
    advertisedHost: Option.fromNullishOr(input.exposure.advertisedHost),
    tailscaleServeEnabled: input.settings.tailscaleServeEnabled,
    tailscaleServePort: input.settings.tailscaleServePort,
  };
}

function resolveRuntimeState(input: {
  readonly requestedMode: DesktopServerExposureMode;
  readonly settings: DesktopSettings;
  readonly port: number;
  readonly networkInterfaces: DesktopNetworkInterfaces;
}): ResolvedRuntimeState {
  const advertisedHostOverride = Option.getOrUndefined(resolveAdvertisedHostOverride());
  const requestedExposure = resolveDesktopServerExposure({
    mode: input.requestedMode,
    port: input.port,
    networkInterfaces: input.networkInterfaces,
    ...(advertisedHostOverride ? { advertisedHostOverride } : {}),
  });
  const unavailable =
    input.requestedMode === "network-accessible" && requestedExposure.endpointUrl === null;
  const exposure = unavailable
    ? resolveDesktopServerExposure({
        mode: "local-only",
        port: input.port,
        networkInterfaces: input.networkInterfaces,
        ...(advertisedHostOverride ? { advertisedHostOverride } : {}),
      })
    : requestedExposure;

  return {
    state: runtimeStateFromResolvedExposure({
      requestedMode: input.requestedMode,
      settings: input.settings,
      exposure,
      port: input.port,
    }),
    unavailable,
  };
}

const requiresBackendRelaunch = (previous: RuntimeState, next: RuntimeState): boolean =>
  previous.port !== next.port ||
  previous.bindHost !== next.bindHost ||
  previous.localHttpUrl !== next.localHttpUrl;

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const networkInterfaces = yield* DesktopNetwork.DesktopNetworkInterfacesService;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const settingsState = yield* DesktopSettingsState.DesktopSettingsState;
  const stateRef = yield* Ref.make(initialRuntimeState());

  const persistSettings = <A>(
    operation: DesktopServerExposurePersistenceOperation,
    effect: Effect.Effect<
      A,
      DesktopSettingsState.DesktopSettingsPersistenceError,
      FileSystem.FileSystem | Path.Path | DesktopEnvironment.DesktopEnvironment
    >,
  ) =>
    effect.pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new DesktopServerExposurePersistenceError({ operation, cause })),
    );

  const readNetworkInterfaces = networkInterfaces.read;

  const getState = Ref.get(stateRef).pipe(Effect.map(toContractState));
  const backendConfig = Ref.get(stateRef).pipe(Effect.map(toBackendConfig));

  const configureFromSettings = ({ port }: { readonly port: number }) =>
    Effect.gen(function* () {
      const settings = yield* settingsState.get;
      const currentNetworkInterfaces = yield* readNetworkInterfaces;
      const resolved = resolveRuntimeState({
        requestedMode: settings.serverExposureMode,
        settings,
        port,
        networkInterfaces: currentNetworkInterfaces,
      });
      yield* Ref.set(stateRef, resolved.state);
      return toContractState(resolved.state);
    });

  const setMode = (mode: DesktopServerExposureMode) =>
    Effect.gen(function* () {
      const previous = yield* Ref.get(stateRef);
      const currentSettings = yield* settingsState.get;
      const nextSettings = setDesktopServerExposurePreference(currentSettings, mode);
      const currentNetworkInterfaces = yield* readNetworkInterfaces;
      const resolved = resolveRuntimeState({
        requestedMode: mode,
        settings: nextSettings,
        port: previous.port,
        networkInterfaces: currentNetworkInterfaces,
      });

      if (resolved.unavailable) {
        return yield* Effect.fail(
          new DesktopServerExposureNoNetworkAddressError({ port: previous.port }),
        );
      }

      if (nextSettings !== currentSettings) {
        yield* persistSettings(
          "server-exposure-mode",
          settingsState.updatePersisted((settings) =>
            setDesktopServerExposurePreference(settings, mode),
          ),
        );
      }

      yield* Ref.set(stateRef, resolved.state);
      return {
        state: toContractState(resolved.state),
        requiresRelaunch: requiresBackendRelaunch(previous, resolved.state),
      };
    });

  const setTailscaleServeEnabled = (input: { readonly enabled: boolean; readonly port?: number }) =>
    Effect.gen(function* () {
      const result = yield* persistSettings(
        "tailscale-serve",
        settingsState.modifyPersisted((settings) => {
          const nextSettings = setDesktopTailscaleServePreference(settings, input);
          return [
            {
              changed: nextSettings !== settings,
              settings: nextSettings,
            },
            nextSettings,
          ] as const;
        }),
      );

      const nextState = yield* Ref.updateAndGet(stateRef, (current) => ({
        ...current,
        tailscaleServeEnabled: result.settings.tailscaleServeEnabled,
        tailscaleServePort: result.settings.tailscaleServePort,
      }));

      return {
        state: toContractState(nextState),
        requiresRelaunch: result.changed,
      };
    });

  const getAdvertisedEndpoints = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const currentNetworkInterfaces = yield* readNetworkInterfaces;
    const coreEndpoints = resolveDesktopCoreAdvertisedEndpoints({
      port: state.port,
      exposure: toResolvedExposure(state),
      customHttpsEndpointUrls: resolveCustomHttpsEndpointUrls(),
    });
    const tailscaleEndpoints = yield* resolveTailscaleAdvertisedEndpoints({
      port: state.port,
      serveEnabled: state.tailscaleServeEnabled,
      servePort: state.tailscaleServePort,
      networkInterfaces: currentNetworkInterfaces,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return [...coreEndpoints, ...tailscaleEndpoints];
  });

  return DesktopServerExposure.of({
    getState,
    backendConfig,
    configureFromSettings,
    setMode,
    setTailscaleServeEnabled,
    getAdvertisedEndpoints,
  });
});

export const layer = Layer.effect(DesktopServerExposure, make);
