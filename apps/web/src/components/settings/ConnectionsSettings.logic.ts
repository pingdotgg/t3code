import {
  isSafeDesktopSshEnvironmentVariableName,
  type AdvertisedEndpoint,
  type DesktopBridge,
  type DesktopWslState,
} from "@t3tools/contracts";

export interface SshEnvironmentVariableDraft {
  readonly name: string;
  readonly value: string;
}

const SSH_ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SSH_ENVIRONMENT_VARIABLE_MAX_COUNT = 128;
const SSH_ENVIRONMENT_VARIABLE_NAME_MAX_LENGTH = 128;
const SSH_ENVIRONMENT_VARIABLE_VALUE_MAX_LENGTH = 8_192;

export function parseSshEnvironmentVariables(
  drafts: ReadonlyArray<SshEnvironmentVariableDraft>,
): Readonly<Record<string, string>> | undefined {
  if (drafts.length > SSH_ENVIRONMENT_VARIABLE_MAX_COUNT) {
    throw new Error(
      `SSH environment variables are limited to ${SSH_ENVIRONMENT_VARIABLE_MAX_COUNT}.`,
    );
  }
  const environmentVariables: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;

  for (const draft of drafts) {
    const name = draft.name.trim();
    if (name.length === 0 && draft.value.length === 0) {
      continue;
    }
    if (!SSH_ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
      throw new Error(
        name.length === 0
          ? "Each SSH environment variable needs a name."
          : `SSH environment variable '${name}' has an invalid name.`,
      );
    }
    if (name.length > SSH_ENVIRONMENT_VARIABLE_NAME_MAX_LENGTH) {
      throw new Error(`SSH environment variable '${name}' has a name longer than 128 characters.`);
    }
    if (!isSafeDesktopSshEnvironmentVariableName(name)) {
      throw new Error(
        `SSH environment variable '${name}' can affect the local SSH process and is not allowed.`,
      );
    }
    if (draft.value.length > SSH_ENVIRONMENT_VARIABLE_VALUE_MAX_LENGTH) {
      throw new Error(`SSH environment variable '${name}' has a value larger than 8 KiB.`);
    }
    if (draft.value.includes("\0")) {
      throw new Error(`SSH environment variable '${name}' contains a NUL character.`);
    }
    if (Object.hasOwn(environmentVariables, name)) {
      throw new Error(`SSH environment variable '${name}' is listed more than once.`);
    }
    environmentVariables[name] = draft.value;
  }

  return Object.keys(environmentVariables).length === 0 ? undefined : environmentVariables;
}

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
