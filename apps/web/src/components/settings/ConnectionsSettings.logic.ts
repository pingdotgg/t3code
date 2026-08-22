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

/**
 * Hides rows the user already revoked while the auth-access stream catches up.
 * Drops ids that left the live snapshot so the set does not grow forever.
 */
export function reconcileHiddenAccessIds(
  hiddenIds: ReadonlySet<string>,
  liveIds: ReadonlySet<string>,
): ReadonlySet<string> {
  if (hiddenIds.size === 0) {
    return hiddenIds;
  }
  let changed = false;
  const next = new Set<string>();
  for (const id of hiddenIds) {
    if (liveIds.has(id)) {
      next.add(id);
    } else {
      changed = true;
    }
  }
  return changed ? next : hiddenIds;
}

export function excludeHiddenAccessRows<T>(
  rows: ReadonlyArray<T>,
  hiddenIds: ReadonlySet<string>,
  idOf: (row: T) => string,
): ReadonlyArray<T> {
  if (hiddenIds.size === 0) {
    return rows;
  }
  return rows.filter((row) => !hiddenIds.has(idOf(row)));
}

export function withHiddenAccessId(
  hiddenIds: ReadonlySet<string>,
  id: string,
): ReadonlySet<string> {
  if (hiddenIds.has(id)) {
    return hiddenIds;
  }
  const next = new Set(hiddenIds);
  next.add(id);
  return next;
}

export function withHiddenAccessIds(
  hiddenIds: ReadonlySet<string>,
  ids: ReadonlyArray<string>,
): ReadonlySet<string> {
  if (ids.length === 0) {
    return hiddenIds;
  }
  const next = new Set(hiddenIds);
  let changed = false;
  for (const id of ids) {
    if (!next.has(id)) {
      next.add(id);
      changed = true;
    }
  }
  return changed ? next : hiddenIds;
}
