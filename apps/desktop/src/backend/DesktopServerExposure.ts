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
import {
  DEFAULT_TAILSCALE_SERVE_PORT,
  describeTailscaleStderrDiagnostic,
  disableTailscaleServe,
  ensureTailscaleServe,
  formatTailscaleServeUserMessage,
  readTailscaleStatus,
  TailscaleCommandError,
  type TailscaleStderrDiagnostic,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

  for (const interfaceAddresses of Object.values(networkInterfaces)) {
    if (!interfaceAddresses) continue;

    for (const address of interfaceAddresses) {
      if (address.internal) continue;
      if (address.family !== "IPv4") continue;
      if (!isUsableLanIpv4Address(address.address)) continue;
      return address.address;
    }
  }

  return null;
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
    } catch {
      // Ignore malformed user-configured endpoints without dropping valid endpoints.
    }
  }

  return endpoints;
};

/**
 * Reason text for a `tailscale` exit failure, or undefined when the CLI said
 * nothing we recognize. Callers fall back to their own wording rather than
 * echoing the exit code at the user.
 */
function describeTailscaleServeExitCause(cause: {
  readonly stderrDiagnostic?: TailscaleStderrDiagnostic | undefined;
}): string | undefined {
  if (cause.stderrDiagnostic === undefined) return undefined;
  return describeTailscaleStderrDiagnostic(cause.stderrDiagnostic) ?? undefined;
}

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

export class DesktopTailscaleServeConfigureError extends Schema.TaggedErrorClass<DesktopTailscaleServeConfigureError>()(
  "DesktopTailscaleServeConfigureError",
  {
    enabled: Schema.Boolean,
    port: Schema.NullOr(Schema.Number),
    localPort: Schema.Number,
    /**
     * Safe CLI summary extracted from known `tailscale serve` patterns.
     * Never raw stderr; optional when this is a pure validation failure.
     */
    detail: Schema.optionalKey(Schema.String),
    /** Admin URL from the CLI (`login.tailscale.com/f/serve...`) when present. */
    configureUrl: Schema.NullOr(Schema.String),
    /** Immediate CLI failure when configuration was attempted; absent for validation-only errors. */
    cause: Schema.optionalKey(TailscaleCommandError),
  },
) {
  override get message(): string {
    // Derive only from structural attributes — never cause.message.
    if (this.localPort <= 0 && this.cause === undefined) {
      return "Local backend is not ready yet. Try again in a moment.";
    }
    const parts: string[] = [];
    if (this.detail !== undefined) {
      parts.push(this.detail);
    } else if (this.enabled) {
      parts.push(
        `Failed to configure Tailscale Serve for the local backend on port ${this.localPort}.`,
      );
    } else {
      parts.push(
        `Failed to turn off Tailscale Serve on port ${this.port ?? DEFAULT_TAILSCALE_SERVE_PORT}.`,
      );
    }
    if (!this.enabled) {
      // Append regardless of `detail`: whatever the CLI failed on, the point the
      // user must not miss is that the backend may still be exposed. A teardown
      // failure that only says "could not run the tailscale CLI" reads like a
      // no-op, which is exactly the silent-exposure case this error exists for.
      parts.push("It may still be reachable on your tailnet.");
    }
    if (this.configureUrl !== null) {
      parts.push(`To enable, visit: ${this.configureUrl}`);
    }
    return parts.join(" ");
  }
}

export const DesktopServerExposureSetModeError = Schema.Union([
  DesktopServerExposureNoNetworkAddressError,
  DesktopServerExposureModePersistenceError,
]);
export type DesktopServerExposureSetModeError = typeof DesktopServerExposureSetModeError.Type;
export const isDesktopServerExposureSetModeError = Schema.is(DesktopServerExposureSetModeError);

export const DesktopServerExposureSetTailscaleServeError = Schema.Union([
  DesktopTailscaleServePersistenceError,
  DesktopTailscaleServeConfigureError,
]);
export type DesktopServerExposureSetTailscaleServeError =
  typeof DesktopServerExposureSetTailscaleServeError.Type;
export const isDesktopServerExposureSetTailscaleServeError = Schema.is(
  DesktopServerExposureSetTailscaleServeError,
);

export const DesktopServerExposureError = Schema.Union([
  DesktopServerExposureNoNetworkAddressError,
  DesktopServerExposureModePersistenceError,
  DesktopTailscaleServePersistenceError,
  DesktopTailscaleServeConfigureError,
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
    }) => Effect.Effect<DesktopServerExposureChange, DesktopServerExposureSetTailscaleServeError>;
    readonly getAdvertisedEndpoints: Effect.Effect<readonly AdvertisedEndpoint[]>;
    /**
     * User-initiated MagicDNS resolve for the Tailscale HTTPS setup flow.
     * Spawns `tailscale status` (cached). Unlike getAdvertisedEndpoints, this
     * runs even when network access is local-only and Serve is still off so
     * Settings can offer the toggle without probing on every panel mount.
     */
    readonly resolveTailscaleHttpsEndpoint: Effect.Effect<AdvertisedEndpoint | null>;
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
  const [cachedReadMagicDnsName, invalidateCachedMagicDnsName] =
    yield* Effect.cachedInvalidateWithTTL(
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

      // Preflight Serve configuration before persisting so Enable can fail loudly
      // with the same CLI guidance (including the admin setup URL) instead of a
      // silent restart that leaves the toggle unchecked. If settings write fails
      // after Serve is already active, roll Serve back so we do not leave
      // unintended network exposure with UI/settings still showing disabled.
      let preflightedServePort: number | null = null;
      let revertEnableBinding: { readonly servePort: number; readonly localPort: number } | null =
        null;
      if (input.enabled) {
        const current = yield* Ref.get(stateRef);
        const servePort = input.port ?? current.tailscaleServePort;
        const localPort = current.port;
        if (localPort <= 0) {
          return yield* new DesktopTailscaleServeConfigureError({
            enabled: true,
            port: servePort,
            localPort,
            configureUrl: null,
          });
        }

        yield* ensureTailscaleServe({
          localPort,
          servePort,
          localHost: "127.0.0.1",
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.mapError((cause) => {
            // Lift only safe structural diagnostics from the CLI error; keep the
            // full TailscaleCommandError as cause for the error chain/stack.
            // Exit errors already carry a vetted `detail`; spawn/timeout/output
            // errors have none, and the generic "port N" fallback hides the most
            // common failure (Tailscale not installed or not on PATH), so use the
            // shared user-facing copy for those.
            const exitDetail =
              cause._tag === "TailscaleCommandExitError"
                ? describeTailscaleServeExitCause(cause)
                : formatTailscaleServeUserMessage(cause);
            const configureUrl =
              cause._tag === "TailscaleCommandExitError" ? (cause.configureUrl ?? null) : null;
            return new DesktopTailscaleServeConfigureError({
              enabled: true,
              port: servePort,
              localPort,
              ...(exitDetail === undefined ? {} : { detail: exitDetail }),
              configureUrl,
              cause,
            });
          }),
        );
        // Only roll back a binding this preflight actually created. When Serve
        // was already enabled on the same port, `tailscale serve --bg` is a
        // no-op and disabling it on a persistence failure would tear down a
        // working HTTPS endpoint that settings still record as enabled.
        preflightedServePort =
          current.tailscaleServeEnabled && current.tailscaleServePort === servePort
            ? null
            : servePort;
      } else {
        // Tear Serve down here rather than leaving it to the child server's
        // acquireRelease finalizer. That finalizer only exists when the *current*
        // child booted with Serve enabled, so after a failed relaunch (which
        // `lifecycle.relaunch` logs and swallows) disabling would persist
        // `enabled: false` while `tailscale serve --https=<port>` stayed live on
        // the tailnet. Fail loudly instead of reporting a teardown we did not do.
        const current = yield* Ref.get(stateRef);
        let removedBinding = false;
        if (current.tailscaleServeEnabled) {
          const servePort = current.tailscaleServePort;
          removedBinding = yield* disableTailscaleServe({ servePort }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            Effect.as(true),
            // `serve off` on a port with nothing bound exits non-zero with
            // "handler does not exist". The tailnet is already in the state the
            // user asked for, so treating that as a failure would strand the
            // toggle on and warn about an exposure that does not exist — and it
            // would bite hardest in the very case this eager teardown exists
            // for, where settings say enabled but no child ever bound Serve.
            Effect.catchTag("TailscaleCommandExitError", (cause) =>
              cause.stderrDiagnostic === "no-existing-handler"
                ? Effect.succeed(false)
                : Effect.fail(cause),
            ),
            Effect.mapError((cause) => {
              const exitDetail =
                cause._tag === "TailscaleCommandExitError"
                  ? describeTailscaleServeExitCause(cause)
                  : formatTailscaleServeUserMessage(cause);
              return new DesktopTailscaleServeConfigureError({
                enabled: false,
                port: servePort,
                localPort: current.port,
                ...(exitDetail === undefined ? {} : { detail: exitDetail }),
                configureUrl: null,
                cause,
              });
            }),
          );
          // Mirror the enable path's rollback. Serve is already down; if the
          // settings write now fails, both stateRef and the persisted document
          // still say enabled, so without this the UI would advertise an HTTPS
          // endpoint that no longer answers. Only when we actually removed a
          // binding, though — re-creating one that was never there would expose
          // the backend rather than restore it.
          if (removedBinding && current.port > 0) {
            revertEnableBinding = { servePort, localPort: current.port };
          }
        }
      }

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
          // Put the tailnet back the way the still-unchanged settings describe
          // it. `onExit` rather than `tapError`: the tailnet has already been
          // changed by this point, so an interrupt (app quitting mid-toggle) or
          // a defect must undo it too — `tapError` sees only typed failures, and
          // skipping the rollback on those exits is exactly the silent-exposure
          // case this whole path exists to prevent. Best-effort, since the
          // original persistence failure is what the caller needs to see.
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) return Effect.void;
            if (preflightedServePort !== null) {
              return disableTailscaleServe({ servePort: preflightedServePort }).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                Effect.ignore,
              );
            }
            if (revertEnableBinding !== null) {
              return ensureTailscaleServe({
                localPort: revertEnableBinding.localPort,
                servePort: revertEnableBinding.servePort,
                localHost: "127.0.0.1",
              }).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                Effect.ignore,
              );
            }
            return Effect.void;
          }),
        );

      const nextState = yield* Ref.updateAndGet(stateRef, (current) => ({
        ...current,
        tailscaleServeEnabled: result.settings.tailscaleServeEnabled,
        tailscaleServePort: result.settings.tailscaleServePort,
      }));

      return {
        state: toContractState(nextState),
        // Always relaunch after a successful enable preflight so the child
        // server re-binds Serve to its current listen port (which may change).
        requiresRelaunch: result.changed || input.enabled,
      };
    },
  );

  const resolveTailscaleEndpoints = Effect.fn("desktop.serverExposure.resolveTailscaleEndpoints")(
    function* (input: { readonly state: RuntimeState }) {
      const currentNetworkInterfaces = yield* readNetworkInterfaces;
      return yield* resolveTailscaleAdvertisedEndpoints({
        port: input.state.port,
        serveEnabled: input.state.tailscaleServeEnabled,
        servePort: input.state.tailscaleServePort,
        networkInterfaces: currentNetworkInterfaces,
        readMagicDnsName: cachedReadMagicDnsName,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
    },
  );

  const getAdvertisedEndpoints = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const coreEndpoints = resolveDesktopCoreAdvertisedEndpoints({
      port: state.port,
      exposure: toResolvedExposure(state),
      customHttpsEndpointUrls: config.desktopHttpsEndpointUrls,
    });

    // Don't spawn the Tailscale CLI on every Connections panel mount when the
    // user hasn't opted into network exposure or Serve yet. MAS Tailscale's
    // CLI lives in a sandbox, so each spawn re-fires the "Other apps" TCC
    // prompt (#2745). Tailscale HTTPS setup uses resolveTailscaleHttpsEndpoint
    // on explicit user interaction instead (Serve is independent of LAN bind).
    if (state.mode !== "network-accessible" && !state.tailscaleServeEnabled) {
      return coreEndpoints;
    }

    const tailscaleEndpoints = yield* resolveTailscaleEndpoints({ state });
    return [...coreEndpoints, ...tailscaleEndpoints];
  }).pipe(Effect.withSpan("desktop.serverExposure.getAdvertisedEndpoints"));

  const resolveTailscaleHttpsEndpoint = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    // This resolve is explicitly user-initiated ("turn on Tailscale HTTPS"), and
    // the failure toast tells the user to start Tailscale and retry. Serving a
    // stale cached miss for the rest of the TTL would make that retry fail for
    // no reason, so force a fresh `tailscale status` here.
    yield* invalidateCachedMagicDnsName;
    const tailscaleEndpoints = yield* resolveTailscaleEndpoints({ state });
    return (
      tailscaleEndpoints.find(
        (endpoint) =>
          endpoint.provider.id === "tailscale" && endpoint.httpBaseUrl.startsWith("https:"),
      ) ?? null
    );
  }).pipe(Effect.withSpan("desktop.serverExposure.resolveTailscaleHttpsEndpoint"));

  return DesktopServerExposure.of({
    getState,
    backendConfig,
    configureFromSettings,
    setMode,
    setTailscaleServeEnabled,
    getAdvertisedEndpoints,
    resolveTailscaleHttpsEndpoint,
  });
});

export const layer = Layer.effect(DesktopServerExposure, make);
