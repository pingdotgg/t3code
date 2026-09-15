import type { AdvertisedEndpoint, DesktopBridge, DesktopWslState } from "@t3tools/contracts";

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

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

/** Sits under the 10s remote request timeout so the hint lands before a dead host errors out. */
export const ADD_ENVIRONMENT_SLOW_HINT_MS = 8_000;

export function describeAddEnvironmentProgress(input: {
  readonly mode: "remote" | "ssh";
  readonly host: string;
  readonly elapsedMs: number;
}): { readonly title: string; readonly detail: string; readonly elapsedLabel: string } {
  const { mode, host, elapsedMs } = input;
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const seconds = totalSeconds % 60;
  const elapsedLabel = `${Math.floor(totalSeconds / 60)}:${String(seconds).padStart(2, "0")}`;
  const isSlow = elapsedMs >= ADD_ENVIRONMENT_SLOW_HINT_MS;

  if (mode === "ssh") {
    return {
      title: `Connecting to ${host} over SSH…`,
      detail: isSlow
        ? "Still working. First-time setup installs T3 Code on the remote machine and can take a few minutes."
        : "Starting the T3 Code server on the remote machine.",
      elapsedLabel,
    };
  }
  return {
    title: `Contacting ${host}…`,
    detail: isSlow
      ? "Still waiting for the host. Check that it is reachable from this device."
      : "Verifying the pairing code and saving the environment.",
    elapsedLabel,
  };
}

/** The host a user typed, reduced to what identifies the server: no scheme, path, or pairing token. */
export function displayPairingHost(input: string): string {
  const raw = input.trim();
  for (const candidate of [raw, `http://${raw}`]) {
    try {
      const host = new URL(candidate).host;
      if (host) return host;
    } catch {
      // fall through to the next candidate
    }
  }
  return raw;
}
