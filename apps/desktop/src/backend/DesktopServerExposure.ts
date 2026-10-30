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
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import {
  createTailscaleIpAdvertisedEndpoint,
  resolveTailscaleAdvertisedEndpoints,
} from "./tailscaleEndpointProvider.ts";

const TAILSCALE_STATUS_CACHE_TTL = Duration.seconds(60);

const WSL_ADDRESSES_CACHE_TTL = Duration.seconds(60);

const DESKTOP_LOOPBACK_HOST = "127.0.0.1";
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
  !address.startsWith("127.") &&
  !address.startsWith("169.254.") &&
  !isTailscaleIpv4Address(address);

// Private bridges and VM adapters are fallbacks; host bridges can carry the real LAN address.
const HOST_ONLY_INTERFACE =
  /^(bridge\d|utun|ipsec|ppp|tun|tap|wg|docker|br-|veth|virbr|vmnet|vboxnet|VirtualBox|VMware)/;

const isHttpsEndpointUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const resolveLanAdvertisedHost = (
  networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces,
  explicitHost: string | undefined,
): string | null => {
  const normalizedExplicitHost = normalizeOptionalHost(explicitHost);
  if (normalizedExplicitHost) {
    return normalizedExplicitHost;
  }

  const lanAddresses = Object.entries(networkInterfaces).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter(
        (address) =>
          !address.internal && address.family === "IPv4" && isUsableLanIpv4Address(address.address),
      )
      .map((address) => ({ name, address: address.address })),
  );
  const preferred =
    lanAddresses.find(({ name }) => !HOST_ONLY_INTERFACE.test(name)) ?? lanAddresses[0];
  return preferred?.address ?? null;
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

  const advertisedHost = resolveLanAdvertisedHost(
    input.networkInterfaces,
    input.advertisedHostOverride,
  );

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

  if (input.exposure.endpointUrl) {
    endpoints.push(
      createDesktopEndpoint({
        id: `desktop-lan:${input.exposure.endpointUrl}`,
        label: "Local network",
        httpBaseUrl: input.exposure.endpointUrl,
        reachability: "lan",
        status: "available",
        isDefault: true,
        description: "Reachable from devices on the same network.",
      }),
    );
  }

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
    } catch {}
  }

  return endpoints;
};

// NAT distros cannot receive traffic on Windows interface addresses; mirrored distros can.
const selectWslReachableEndpoints = (input: {
  readonly port: number;
  readonly windowsEndpoints: readonly AdvertisedEndpoint[];
  readonly preserveLanEndpoint: boolean;
  readonly distroAddresses: readonly string[];
  /** The subset of `distroAddresses` the distro's own Tailscale reports. */
  readonly distroTailscaleAddresses: readonly string[];
}): readonly AdvertisedEndpoint[] => {
  const hostOf = (endpoint: AdvertisedEndpoint) => new URL(endpoint.httpBaseUrl).hostname;
  const isHostAddress = (endpoint: AdvertisedEndpoint) =>
    (!input.preserveLanEndpoint && endpoint.id.startsWith("desktop-lan:")) ||
    endpoint.id.startsWith("tailscale-ip:");

  const kept = input.windowsEndpoints.filter(
    (endpoint) => !isHostAddress(endpoint) || input.distroAddresses.includes(hostOf(endpoint)),
  );
  const knownUrls = new Set(kept.map((endpoint) => endpoint.httpBaseUrl));
  const distroTailscale = input.distroTailscaleAddresses
    .filter((address) => input.distroAddresses.includes(address))
    .map((address) => createTailscaleIpAdvertisedEndpoint({ address, port: input.port }))
    .filter((endpoint) => !knownUrls.has(endpoint.httpBaseUrl));
  return [...kept, ...distroTailscale];
};

export class DesktopServerExposureNoNetworkAddressError extends Schema.TaggedError<DesktopServerExposureNoNetworkAddressError>()(
  "DesktopServerExposureNoNetworkAddressError",
  {
    port: Schema.Number,
  },
) {
  override get message(): string {
    return `No reachable network address is available for desktop network access on port ${this.port}.`;
  }
}

export class DesktopServerExposureModePersistenceError extends Schema.TaggedError<DesktopServerExposureModePersistenceError>()(
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

export class DesktopTailscaleServePersistenceError extends Schema.TaggedError<DesktopTailscaleServePersistenceError>()(
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

export const DesktopServerExposureError = Schema.Union([
  DesktopServerExposureNoNetworkAddressError,
  DesktopServerExposureModePersistenceError,
  DesktopTailscaleServePersistenceError,
]);
export type DesktopServerExposureError = typeof DesktopServerExposureError.Type;

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
    // Pin probes to the selected primary, independent of later settings or default-distro changes.
    readonly setWslPrimary: (wsl: { readonly distro: string | null } | null) => Effect.Effect<void>;
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
    input.requestedMode === "network-accessible" &&
    requestedExposure.endpointUrl === null &&
    !Object.values(input.networkInterfaces).some((addresses) =>
      addresses?.some(
        (address) =>
          !address.internal && address.family === "IPv4" && isTailscaleIpv4Address(address.address),
      ),
    );
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

const tailscaleIpv4AddressKey = (
  networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces,
): string =>
  [
    ...new Set(
      Object.values(networkInterfaces)
        .flatMap((addresses) => addresses ?? [])
        .filter(
          (address) =>
            !address.internal &&
            address.family === "IPv4" &&
            isTailscaleIpv4Address(address.address),
        )
        .map((address) => address.address),
    ),
  ]
    .toSorted()
    .join(",");

const requiresBackendRelaunch = (previous: RuntimeState, next: RuntimeState): boolean =>
  previous.port !== next.port ||
  previous.bindHost !== next.bindHost ||
  previous.localHttpUrl !== next.localHttpUrl;

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const networkInterfaces = yield* DesktopNetworkInterfaces.DesktopNetworkInterfaces;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const stateRef = yield* Ref.make(initialRuntimeState());
  const wslPrimaryRef = yield* Ref.make<{ readonly distro: string | null } | null>(null);
  // Serialize read-persist-write changes so stale runtime state cannot overwrite another update.
  const changePermit = yield* Semaphore.make(1);

  // Key status by interface addresses so network changes bypass stale DNS and
  // identity. Cache unchanged addresses to avoid repeated macOS TCC prompts.
  const tailscaleStatusCache = yield* Cache.make({
    capacity: 1,
    timeToLive: TAILSCALE_STATUS_CACHE_TTL,
    lookup: (_addresses: string) =>
      readTailscaleStatus.pipe(
        Effect.orElseSucceed(() => null),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      ),
  });

  // The distro's addresses and the subset its own Tailscale reports, keyed by
  // distro ("" is the default distro). `None` means the address probe failed,
  // so callers keep the Windows addresses.
  const wslAddressesCache = yield* Cache.make({
    capacity: 1,
    timeToLive: WSL_ADDRESSES_CACHE_TTL,
    lookup: Effect.fn("DesktopServerExposure.probeWslAddresses")(
      function* (distro: string) {
        const target = distro === "" ? null : distro;
        const addresses = yield* DesktopWslEnvironment.probeDistroIpv4Addresses(target);
        if (Option.isNone(addresses)) return Option.none();
        const tailscale = yield* DesktopWslEnvironment.probeDistroTailscaleIpv4Addresses(target);
        return Option.some({ addresses: addresses.value, tailscale });
      },
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    ),
  });

  const readNetworkInterfaces = networkInterfaces.read;

  const getState = Effect.gen(function* () {
    const state = toContractState(yield* Ref.get(stateRef));
    const wslPrimary = yield* Ref.get(wslPrimaryRef);
    if (!state.endpointUrl || wslPrimary === null || Option.isSome(config.desktopLanHostOverride)) {
      return state;
    }
    const probe = yield* Cache.get(wslAddressesCache, wslPrimary.distro ?? "");
    if (
      Option.isNone(probe) ||
      probe.value.addresses.includes(new URL(state.endpointUrl).hostname)
    ) {
      return state;
    }
    return { ...state, endpointUrl: null, advertisedHost: null };
  });
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
  }, changePermit.withPermit);

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
    changePermit.withPermit,
  );

  const getAdvertisedEndpoints = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const currentNetworkInterfaces = yield* readNetworkInterfaces;
    const coreEndpoints = resolveDesktopCoreAdvertisedEndpoints({
      port: state.port,
      exposure: toResolvedExposure(state),
      customHttpsEndpointUrls: config.desktopHttpsEndpointUrls,
    });

    // Spawning Mac App Store Tailscale can prompt for TCC access even when exposure is disabled.
    if (state.mode !== "network-accessible" && !state.tailscaleServeEnabled) {
      return coreEndpoints;
    }

    const tailscaleEndpoints = yield* resolveTailscaleAdvertisedEndpoints({
      port: state.port,
      serveEnabled: state.tailscaleServeEnabled,
      servePort: state.tailscaleServePort,
      networkInterfaces: currentNetworkInterfaces,
      readStatus: Cache.get(
        tailscaleStatusCache,
        tailscaleIpv4AddressKey(currentNetworkInterfaces),
      ),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    const windowsEndpoints = [...coreEndpoints, ...tailscaleEndpoints];

    // A WSL primary listens inside the distro, which under NAT networking has
    // its own addresses. If the distro can't be probed (or WSL is unavailable
    // and the Windows primary is running instead), keep the Windows addresses.
    const wslPrimary = yield* Ref.get(wslPrimaryRef);
    if (wslPrimary === null) {
      return windowsEndpoints;
    }
    const distroAddresses = yield* Cache.get(wslAddressesCache, wslPrimary.distro ?? "");
    if (Option.isNone(distroAddresses)) {
      yield* Effect.logDebug("could not read the WSL distro's addresses; advertising Windows ones");
      return windowsEndpoints;
    }
    return selectWslReachableEndpoints({
      port: state.port,
      windowsEndpoints,
      preserveLanEndpoint: Option.isSome(config.desktopLanHostOverride),
      distroAddresses: distroAddresses.value.addresses,
      distroTailscaleAddresses: distroAddresses.value.tailscale,
    });
  }).pipe(Effect.withSpan("desktop.serverExposure.getAdvertisedEndpoints"));

  return DesktopServerExposure.of({
    getState,
    backendConfig,
    configureFromSettings,
    setMode,
    setTailscaleServeEnabled,
    getAdvertisedEndpoints,
    setWslPrimary: Effect.fn("DesktopServerExposure.setWslPrimary")((wsl) =>
      Ref.set(wslPrimaryRef, wsl),
    ),
  });
});

export const layer = Layer.effect(DesktopServerExposure, make);
