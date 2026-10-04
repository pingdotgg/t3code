import type {
  AdvertisedEndpoint,
  DesktopBridge,
  DesktopWslState,
  RunningLocalServer,
} from "@t3tools/contracts";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import type { EnvironmentPresentation } from "../../state/environments";

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

export type LocalServerPairingStatus = "pair" | "pair-again" | "paired" | "version-mismatch";

export interface LocalServerPairingCandidate {
  readonly server: RunningLocalServer;
  readonly status: LocalServerPairingStatus;
}

/**
 * Discovered servers this client could pair with. This machine's own and
 * desktop-managed backends are never candidates. A saved environment is only
 * offered again once its connection has failed.
 */
export function selectLocalServerPairingCandidates(
  servers: ReadonlyArray<RunningLocalServer>,
  environments: ReadonlyArray<
    Pick<EnvironmentPresentation, "environmentId" | "entry" | "connection">
  >,
): ReadonlyArray<LocalServerPairingCandidate> {
  return servers.flatMap((server): LocalServerPairingCandidate[] => {
    const saved = environments.find(
      (environment) => environment.environmentId === server.environmentId,
    );
    if (
      saved?.entry.target._tag === "PrimaryConnectionTarget" ||
      (saved !== undefined && isDesktopLocalConnectionTarget(saved.entry.target))
    ) {
      return [];
    }
    const status: LocalServerPairingStatus =
      saved !== undefined && saved.connection.phase !== "error"
        ? "paired"
        : server.pairing === "version-mismatch"
          ? "version-mismatch"
          : saved !== undefined
            ? "pair-again"
            : "pair";
    return [{ server, status }];
  });
}

/**
 * A QR code encoding a loopback URL makes the scanning device dial itself, so
 * loopback endpoints stay copyable from the endpoint menu but are never
 * offered as QR targets.
 */
export function isQrShareableEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.status !== "unavailable" && endpoint.reachability !== "loopback";
}

export function isWslSettingsRowVisible(input: {
  readonly state: DesktopWslState | null;
  readonly error: string | null;
}): boolean {
  const { state, error } = input;
  return state ? state.available || state.enabled || state.wslOnly : error !== null;
}

export type QrEndpointOption = {
  /** Unique per endpoint instance (AdvertisedEndpoint.id); safe as a React key. */
  readonly id: string;
  /**
   * Stable per endpoint *type* (endpointDefaultPreferenceKey). Multiple
   * endpoints can share one, so it is only used to match the saved default.
   */
  readonly preferenceKey: string;
  /** False for endpoints that stay copyable but must never render as a QR. */
  readonly qrShareable: boolean;
};

/**
 * Resolves which endpoint the share panel shows: the user's explicit pick,
 * else the saved default endpoint, else the first QR-shareable option (so the
 * panel never opens on a loopback QR), else the first option. A stale
 * selectedId (endpoint disappeared) falls back rather than blanking the panel.
 */
export function selectQrEndpointOption<T extends QrEndpointOption>(
  options: ReadonlyArray<T>,
  selectedId: string | null,
  defaultPreferenceKey: string | null,
): T | null {
  return (
    (selectedId !== null ? options.find((option) => option.id === selectedId) : undefined) ??
    (defaultPreferenceKey !== null
      ? options.find((option) => option.preferenceKey === defaultPreferenceKey)
      : undefined) ??
    options.find((option) => option.qrShareable) ??
    options[0] ??
    null
  );
}

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge;
  readonly mode: "both" | "wsl-only";
  readonly nextDistro: string | null;
  readonly persistedDistro: string | null;
}): Promise<DesktopWslState> {
  const { bridge, mode, nextDistro, persistedDistro } = input;

  // Stage every preference before enabling. The desktop only relaunches for
  // mode/distro changes while WSL is active, so the final enable observes the
  // complete selection and is the only call that may relaunch.
  await bridge.setWslOnly(mode === "wsl-only");
  if (persistedDistro !== nextDistro) {
    await bridge.setWslDistro(nextDistro);
  }
  return await bridge.setWslBackendEnabled(true);
}
