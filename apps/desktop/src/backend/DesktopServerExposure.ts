import {
  createAdvertisedEndpoint,
  type CreateAdvertisedEndpointInput,
} from "@t3tools/shared/advertisedEndpoint";
import {
  DesktopServerExposureModeSchema,
  type AdvertisedEndpoint,
  type AdvertisedEndpointProvider,
  type DesktopServerExposureMode,
  type DesktopServerExposureState,
} from "@t3tools/contracts";
import { isTailscaleIpv4Address, readTailscaleStatus } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";
import { resolveTailscaleAdvertisedEndpoints } from "./tailscaleEndpointProvider.ts";

const TAILSCALE_STATUS_CACHE_TTL = Duration.seconds(60);

export const DESKTOP_LOOPBACK_HOST = "127.0.0.1";
const DESKTOP_LAN_BIND_HOST = "0.0.0.0";

interface ResolvedDesktopServerExposure {
  readonly mode: DesktopServerExposureMode;
  readonly bindHost: string;
  readonly localHttpUrl: string;
  readonly localWsUrl: string;
  readonly endpointUrl: string | null;
  readonly advertisedHost: string | null;
}

interface DesktopAdvertisedEndpointInput {
  readonly port: number;
  readonly exposure: ResolvedDesktopServerExposure;
  readonly advertisedLanHosts: readonly LanAdvertisedHost[];
  readonly customHttpsEndpointUrls?: readonly string[];
}

const DESKTOP_CORE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
};

const DESKTOP_MANUAL_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "manual",
  label: "Manual",
  kind: "manual",
  isAddon: false,
};

const normalizeOptionalHost = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
};

const isUsableLanIpv4Address = (address: string): boolean =>
  !address.startsWith("127.") && !address.startsWith("169.254.");

interface LanAdvertisedHost {
  readonly address: string;
  readonly interfaceName: string | null;
}

const isHttpsEndpointUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const resolveLanAdvertisedHosts = (
  networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces,
  explicitHost: string | undefined,
): readonly LanAdvertisedHost[] => {
  const normalizedExplicitHost = normalizeOptionalHost(explicitHost);
  if (normalizedExplicitHost) {
    return [{ address: normalizedExplicitHost, interfaceName: null }];
  }

  const seenAddresses = new Set<string>();
  const lanHosts: LanAdvertisedHost[] = [];
  const tailnetHosts: LanAdvertisedHost[] = [];

  for (const [interfaceName, interfaceAddresses] of Object.entries(networkInterfaces)) {
    if (!interfaceAddresses) continue;

    for (const address of interfaceAddresses) {
      if (address.internal) continue;
      if (!DesktopNetworkInterfaces.isIpv4Family(address.family)) continue;
      if (!isUsableLanIpv4Address(address.address)) continue;
      if (seenAddresses.has(address.address)) continue;
      seenAddresses.add(address.address);

      const host: LanAdvertisedHost = { address: address.address, interfaceName };
      if (isTailscaleIpv4Address(address.address)) {
        tailnetHosts.push(host);
      } else {
        lanHosts.push(host);
      }
    }
  }

  return [...lanHosts, ...tailnetHosts];
};

const resolveDesktopServerExposure = (input: {
  readonly mode: DesktopServerExposureMode;
  readonly port: number;
  readonly networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces;
  readonly advertisedHostOverride?: string;
}): ResolvedDesktopServerExposure => {
  const localHttpUrl = `http://${DESKTOP_LOOPBACK_HOST}:${input.port}`;
  const localWsUrl = `ws://${DESKTOP_LOOPBACK_HOST}:${input.port}`;

  if (input.mode === "local-only") {
    return {
      mode: input.mode,
      bindHost: DESKTOP_LOOPBACK_HOST,
      localHttpUrl,
      localWsUrl,
      endpointUrl: null,
      advertisedHost: null,
    };
  }

  const advertisedLanHosts = resolveLanAdvertisedHosts(
    input.networkInterfaces,
    input.advertisedHostOverride,
  );
  const advertisedHost = advertisedLanHosts[0]?.address ?? null;

  return {
    mode: input.mode,
    bindHost: DESKTOP_LAN_BIND_HOST,
    localHttpUrl,
    localWsUrl,
    endpointUrl: advertisedHost ? `http://${advertisedHost}:${input.port}` : null,
    advertisedHost,
  };
};

const createDesktopEndpoint = (
  input: Omit<CreateAdvertisedEndpointInput, "provider" | "source">,
): AdvertisedEndpoint =>
  createAdvertisedEndpoint({
    ...input,
    provider: DESKTOP_CORE_ENDPOINT_PROVIDER,
    source: "desktop-core",
  });

const createManualEndpoint = (
  input: Omit<CreateAdvertisedEndpointInput, "provider" | "source">,
): AdvertisedEndpoint =>
  createAdvertisedEndpoint({
    ...input,
    provider: DESKTOP_MANUAL_ENDPOINT_PROVIDER,
    source: "user",
  });

const resolveDesktopCoreAdvertisedEndpoints = (
  input: DesktopAdvertisedEndpointInput,
): readonly AdvertisedEndpoint[] => {
  const endpoints: AdvertisedEndpoint[] = [
    createDesktopEndpoint({
      id: `desktop-loopback:${input.port}`,
      label: "This machine",
      httpBaseUrl: input.exposure.localHttpUrl,
      reachability: "loopback",
      status: "available",
      description: "Loopback endpoint for this desktop app.",
    }),
  ];

  const advertisedLanHosts = input.advertisedLanHosts;
  // Tailnet addresses are replaced by the Tailscale provider's own entries
  // below, so only the remaining hosts count toward needing disambiguation.
  const namedLanHostCount = advertisedLanHosts.filter(
    (host) => !isTailscaleIpv4Address(host.address),
  ).length;
  advertisedLanHosts.forEach((host, index) => {
    const httpBaseUrl = `http://${host.address}:${input.port}`;
    const label =
      namedLanHostCount >= 2 && host.interfaceName !== null
        ? `Local network (${host.interfaceName})`
        : "Local network";
    endpoints.push(
      createDesktopEndpoint({
        id: `desktop-lan:${httpBaseUrl}`,
        label,
        httpBaseUrl,
        reachability: "lan",
        status: "available",
        ...(index === 0 ? { isDefault: true } : {}),
        description: "Reachable from devices on the same network.",
      }),
    );
  });

  for (const customEndpointUrl of input.customHttpsEndpointUrls ?? []) {
    try {
      const isHttpsEndpoint = isHttpsEndpointUrl(customEndpointUrl);
      endpoints.push(
        createManualEndpoint({
          id: `manual:${customEndpointUrl}`,
          label: isHttpsEndpoint ? "Custom HTTPS" : "Custom endpoint",
          httpBaseUrl: customEndpointUrl,
          reachability: "public",
          ...(isHttpsEndpoint ? ({ hostedHttpsCompatibility: "compatible" } as const) : {}),
          status: "unknown",
          description: isHttpsEndpoint
            ? "User-configured HTTPS endpoint for this desktop backend."
            : "User-configured endpoint for this desktop backend.",
        }),
      );
    } catch {
      // Ignore malformed user-configured endpoints without dropping valid endpoints.
    }
  }

  return endpoints;
};

export class DesktopServerExposureNoNetworkAddressError extends Schema.TaggedErrorClass<DesktopServerExposureNoNetworkAddressError>()(
  "DesktopServerExposureNoNetworkAddressError",
  {
    port: Schema.Number,
  },
) {
  override get message(): string {
    return `No reachable network address is available for desktop network access on port ${this.port}.`;
  }
}

export class DesktopServerExposureModePersistenceError extends Schema.TaggedErrorClass<DesktopServerExposureModePersistenceError>()(
  "DesktopServerExposureModePersistenceError",
  {
    mode: DesktopServerExposureModeSchema,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist desktop server exposure mode ${this.mode}.`;
  }
}

export class DesktopTailscaleServePersistenceError extends Schema.TaggedErrorClass<DesktopTailscaleServePersistenceError>()(
  "DesktopTailscaleServePersistenceError",
  {
    enabled: Schema.Boolean,
    port: Schema.NullOr(Schema.Number),
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist desktop Tailscale Serve settings (enabled: ${this.enabled}, port: ${this.port ?? "unchanged"}).`;
  }
}

export const DesktopServerExposureSetModeError = Schema.Union([
  DesktopServerExposureNoNetworkAddressError,
  DesktopServerExposureModePersistenceError,
]);
export type DesktopServerExposureSetModeError = typeof DesktopServerExposureSetModeError.Type;
export const isDesktopServerExposureSetModeError = Schema.is(DesktopServerExposureSetModeError);

export const DesktopServerExposureError = Schema.Union([
  DesktopServerExposureNoNetworkAddressError,
  DesktopServerExposureModePersistenceError,
  DesktopTailscaleServePersistenceError,
]);
export type DesktopServerExposureError = typeof DesktopServerExposureError.Type;
export const isDesktopServerExposureError = Schema.is(DesktopServerExposureError);

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

export class DesktopServerExposure extends Context.Service<
  DesktopServerExposure,
  {
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
    }) => Effect.Effect<DesktopServerExposureChange, DesktopTailscaleServePersistenceError>;
    readonly getAdvertisedEndpoints: Effect.Effect<readonly AdvertisedEndpoint[]>;
  }
>()("@t3tools/desktop/backend/DesktopServerExposure") {}

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
    requestedMode: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.serverExposureMode,
    settings: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
    exposure: resolveDesktopServerExposure({
      mode: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.serverExposureMode,
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

function runtimeStateFromResolvedExposure(input: {
  readonly requestedMode: DesktopServerExposureMode;
  readonly settings: DesktopAppSettings.DesktopSettings;
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
  readonly settings: DesktopAppSettings.DesktopSettings;
  readonly port: number;
  readonly networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces;
  readonly advertisedHostOverride: Option.Option<string>;
}): ResolvedRuntimeState {
  const advertisedHostOverride = Option.getOrUndefined(input.advertisedHostOverride);
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

export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const networkInterfaces = yield* DesktopNetworkInterfaces.DesktopNetworkInterfaces;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const stateRef = yield* Ref.make(initialRuntimeState());

  // Cache the `tailscale status` spawn for the TTL. On macOS, the Mac App
  // Store Tailscale CLI lives inside Tailscale's sandbox container, so each
  // spawn re-triggers the "Other apps" TCC prompt.
  const cachedReadMagicDnsName = yield* Effect.cachedWithTTL(
    readTailscaleStatus.pipe(
      Effect.map((status) => status.magicDnsName),
      Effect.orElseSucceed(() => null),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    ),
    TAILSCALE_STATUS_CACHE_TTL,
  );

  const readNetworkInterfaces = networkInterfaces.read;

  const getState = Ref.get(stateRef).pipe(Effect.map(toContractState));
  const backendConfig = Ref.get(stateRef).pipe(Effect.map(toBackendConfig));

  const configureFromSettings = Effect.fn("desktop.serverExposure.configureFromSettings")(
    function* ({ port }: { readonly port: number }) {
      yield* Effect.annotateCurrentSpan({ port });
      const settings = yield* desktopSettings.get;
      const currentNetworkInterfaces = yield* readNetworkInterfaces;
      const resolved = resolveRuntimeState({
        requestedMode: settings.serverExposureMode,
        settings,
        port,
        networkInterfaces: currentNetworkInterfaces,
        advertisedHostOverride: config.desktopLanHostOverride,
      });
      yield* Ref.set(stateRef, resolved.state);
      return toContractState(resolved.state);
    },
  );

  const setMode = Effect.fn("desktop.serverExposure.setMode")(function* (
    mode: DesktopServerExposureMode,
  ) {
    yield* Effect.annotateCurrentSpan({ mode });
    const previous = yield* Ref.get(stateRef);
    const currentSettings = yield* desktopSettings.get;
    const nextSettings = {
      ...currentSettings,
      serverExposureMode: mode,
    };
    const currentNetworkInterfaces = yield* readNetworkInterfaces;
    const resolved = resolveRuntimeState({
      requestedMode: mode,
      settings: nextSettings,
      port: previous.port,
      networkInterfaces: currentNetworkInterfaces,
      advertisedHostOverride: config.desktopLanHostOverride,
    });

    if (resolved.unavailable) {
      return yield* new DesktopServerExposureNoNetworkAddressError({ port: previous.port });
    }

    const change = yield* desktopSettings.setServerExposureMode(mode).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopServerExposureModePersistenceError({
            mode,
            cause,
          }),
      ),
    );

    yield* Ref.set(stateRef, resolved.state);
    return {
      state: toContractState(resolved.state),
      requiresRelaunch: change.changed || requiresBackendRelaunch(previous, resolved.state),
    };
  });

  const setTailscaleServeEnabled = Effect.fn("desktop.serverExposure.setTailscaleServeEnabled")(
    function* (input: { readonly enabled: boolean; readonly port?: number }) {
      yield* Effect.annotateCurrentSpan({
        enabled: input.enabled,
        ...(input.port === undefined ? {} : { port: input.port }),
      });
      const result = yield* desktopSettings
        .setTailscaleServe({
          enabled: input.enabled,
          port: Option.fromNullishOr(input.port),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DesktopTailscaleServePersistenceError({
                enabled: input.enabled,
                port: input.port ?? null,
                cause,
              }),
          ),
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
    },
  );

  const getAdvertisedEndpoints = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const currentNetworkInterfaces = yield* readNetworkInterfaces;
    // Re-resolve LAN hosts on every read so interfaces that appear or vanish
    // after startup (VPNs connecting/disconnecting, hot-plugged NICs) stay
    // accurate. The backend binds 0.0.0.0 in network-accessible mode, so any
    // currently-present address is reachable.
    const advertisedLanHosts =
      state.mode === "network-accessible"
        ? resolveLanAdvertisedHosts(
            currentNetworkInterfaces,
            Option.getOrUndefined(config.desktopLanHostOverride),
          )
        : [];
    const coreEndpoints = resolveDesktopCoreAdvertisedEndpoints({
      port: state.port,
      exposure: toResolvedExposure(state),
      advertisedLanHosts,
      customHttpsEndpointUrls: config.desktopHttpsEndpointUrls,
    });

    // Don't spawn the Tailscale CLI when the user hasn't opted into any
    // network exposure. The spawn itself triggers a macOS "Other apps"
    // TCC prompt on Mac App Store Tailscale builds.
    if (state.mode !== "network-accessible" && !state.tailscaleServeEnabled) {
      return coreEndpoints;
    }

    const tailscaleEndpoints = yield* resolveTailscaleAdvertisedEndpoints({
      port: state.port,
      serveEnabled: state.tailscaleServeEnabled,
      servePort: state.tailscaleServePort,
      networkInterfaces: currentNetworkInterfaces,
      readMagicDnsName: cachedReadMagicDnsName,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    // A tailnet address surfaces through the Tailscale provider's richer
    // entry; drop the plain LAN duplicate but keep the default marker on
    // whichever entry survives.
    const tailscaleUrls = new Set(tailscaleEndpoints.map((endpoint) => endpoint.httpBaseUrl));
    const isDuplicateLanEndpoint = (endpoint: AdvertisedEndpoint): boolean =>
      endpoint.id.startsWith("desktop-lan:") && tailscaleUrls.has(endpoint.httpBaseUrl);
    const droppedDefault = coreEndpoints.find(
      (endpoint) => isDuplicateLanEndpoint(endpoint) && endpoint.isDefault === true,
    );
    return [
      ...coreEndpoints.filter((endpoint) => !isDuplicateLanEndpoint(endpoint)),
      ...tailscaleEndpoints.map((endpoint) =>
        endpoint.httpBaseUrl === droppedDefault?.httpBaseUrl
          ? { ...endpoint, isDefault: true }
          : endpoint,
      ),
    ];
  }).pipe(Effect.withSpan("desktop.serverExposure.getAdvertisedEndpoints"));

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
