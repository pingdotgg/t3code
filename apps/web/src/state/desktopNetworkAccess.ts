import type {
  AdvertisedEndpoint,
  DesktopBridge,
  DesktopServerExposureState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

const DESKTOP_NETWORK_ACCESS_STALE_TIME_MS = 30_000;

type DesktopNetworkAccessBridge = Pick<
  DesktopBridge,
  "getAdvertisedEndpoints" | "getServerExposureState"
>;

export interface DesktopNetworkAccessSnapshot {
  readonly advertisedEndpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly serverExposureState: DesktopServerExposureState;
}

class DesktopNetworkAccessUnavailableError extends Schema.TaggedError<DesktopNetworkAccessUnavailableError>()(
  "DesktopNetworkAccessUnavailableError",
  {},
) {
  override get message(): string {
    return "Desktop network access is unavailable.";
  }
}

class DesktopServerExposureStateLoadError extends Schema.TaggedError<DesktopServerExposureStateLoadError>()(
  "DesktopServerExposureStateLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load desktop server exposure state.";
  }
}

class DesktopAdvertisedEndpointsLoadError extends Schema.TaggedError<DesktopAdvertisedEndpointsLoadError>()(
  "DesktopAdvertisedEndpointsLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load advertised desktop endpoints.";
  }
}

function getDesktopNetworkAccessBridge(): DesktopNetworkAccessBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

export function createDesktopNetworkAccessStateAtom(
  getBridge: () => DesktopNetworkAccessBridge | undefined,
) {
  const loadDesktopNetworkAccess = Effect.fn("loadDesktopNetworkAccess")(function* () {
    const bridge = getBridge();
    if (!bridge) {
      return yield* new DesktopNetworkAccessUnavailableError();
    }
    const [serverExposureState, advertisedEndpoints] = yield* Effect.all(
      [
        Effect.tryPromise({
          try: () => bridge.getServerExposureState(),
          catch: (cause) => new DesktopServerExposureStateLoadError({ cause }),
        }),
        Effect.tryPromise({
          try: () => bridge.getAdvertisedEndpoints(),
          catch: (cause) => new DesktopAdvertisedEndpointsLoadError({ cause }),
        }),
      ],
      { concurrency: "unbounded" },
    );
    return {
      advertisedEndpoints,
      serverExposureState,
    } satisfies DesktopNetworkAccessSnapshot;
  });

  return Atom.make(loadDesktopNetworkAccess()).pipe(
    Atom.swr({
      staleTime: DESKTOP_NETWORK_ACCESS_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.keepAlive,
    Atom.withLabel("desktop:network-access"),
  );
}

export const desktopNetworkAccessStateAtom = createDesktopNetworkAccessStateAtom(
  getDesktopNetworkAccessBridge,
);

export function endpointDefaultPreferenceKey(endpoint: AdvertisedEndpoint): string {
  if (endpoint.id.startsWith("desktop-loopback:")) return "desktop-core:loopback:http";
  if (endpoint.id.startsWith("desktop-lan:")) return "desktop-core:lan:http";
  if (endpoint.id.startsWith("tailscale-ip:")) return "tailscale:ip:http";
  if (endpoint.id.startsWith("tailscale-magicdns:")) return "tailscale:magicdns:https";

  let scheme = "unknown";
  try {
    scheme = new URL(endpoint.httpBaseUrl).protocol.replace(/:$/u, "");
  } catch {
    // Keep the stored preference stable even if a custom endpoint is malformed.
  }
  return `${endpoint.provider.id}:${endpoint.reachability}:${scheme}:${endpoint.label}`;
}

export function selectDefaultAdvertisedEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  defaultEndpointKey?: string | null,
): AdvertisedEndpoint | null {
  const availableEndpoints = endpoints.filter((endpoint) => endpoint.status !== "unavailable");
  if (defaultEndpointKey) {
    const selected = availableEndpoints.find(
      (endpoint) => endpointDefaultPreferenceKey(endpoint) === defaultEndpointKey,
    );
    if (selected) return selected;
  }
  return (
    availableEndpoints.find((endpoint) => endpoint.isDefault) ??
    availableEndpoints.find((endpoint) => endpoint.reachability !== "loopback") ??
    availableEndpoints.find((endpoint) => endpoint.compatibility.hostedHttpsApp === "compatible") ??
    null
  );
}

export function refreshDesktopNetworkAccessState(): void {
  appAtomRegistry.refresh(desktopNetworkAccessStateAtom);
}
