import type {
  ManagedProviderRuntime,
  ProviderRuntimeSettings,
  ServerProvider,
} from "@t3tools/contracts";

/** Drivers Continuum can run from a runtime it downloads itself. */
const MANAGED_DRIVERS = { claudeAgent: "claude", codex: "codex" } as const;
export type ManagedDriver = keyof typeof MANAGED_DRIVERS;

const isManagedDriver = (driver: string): driver is ManagedDriver =>
  Object.hasOwn(MANAGED_DRIVERS, driver);

export type RuntimePlan =
  | { readonly kind: "none" }
  | { readonly kind: "in-place-update" }
  | { readonly kind: "use-managed"; readonly driver: ManagedDriver }
  | { readonly kind: "refresh-managed"; readonly driver: ManagedDriver };

/** True when the CLI is behind, incompatible, or hides models that need a newer build. */
export function providerIsOutdated(
  provider: Pick<
    ServerProvider,
    "versionAdvisory" | "compatibilityAdvisory" | "updateRequiredModels"
  >,
): boolean {
  const compatibility = provider.compatibilityAdvisory?.status;
  return (
    provider.versionAdvisory?.status === "behind_latest" ||
    (compatibility !== undefined && compatibility !== "supported" && compatibility !== "unknown") ||
    (provider.updateRequiredModels?.length ?? 0) > 0
  );
}

export function planRuntimeUpdate(input: {
  readonly provider: Pick<
    ServerProvider,
    | "driver"
    | "installed"
    | "enabled"
    | "versionAdvisory"
    | "compatibilityAdvisory"
    | "updateRequiredModels"
  >;
  /** The instance's configured binary path; empty means the default command. */
  readonly binaryPath: string;
  readonly managed: ManagedProviderRuntime | undefined;
  readonly settings: ProviderRuntimeSettings;
}): RuntimePlan {
  const { provider, settings } = input;
  if (settings.mode !== "auto" || !provider.enabled) return { kind: "none" };
  const driver = provider.driver;
  if (input.managed !== undefined) {
    // Only refresh a runtime Continuum still owns; a hand-edited path is the user's again.
    return isManagedDriver(driver) &&
      input.binaryPath === input.managed.executablePath &&
      providerIsOutdated(provider)
      ? { kind: "refresh-managed", driver }
      : { kind: "none" };
  }
  if (!providerIsOutdated(provider)) return { kind: "none" };
  if (provider.versionAdvisory?.canUpdate === true && settings.updateUserInstalls) {
    return { kind: "in-place-update" };
  }
  if (!isManagedDriver(driver)) return { kind: "none" };
  const defaultCommand = MANAGED_DRIVERS[driver as ManagedDriver];
  const usesDefaultCommand = input.binaryPath === "" || input.binaryPath === defaultCommand;
  // A custom binary path is a deliberate choice; leave it alone.
  return usesDefaultCommand ? { kind: "use-managed", driver } : { kind: "none" };
}

/** Claude Code's platform key in its release manifest. */
export function claudePlatformKey(input: {
  readonly platform: string;
  readonly arch: string;
  readonly musl: boolean;
}): string | null {
  const arch = input.arch === "x64" ? "x64" : input.arch === "arm64" ? "arm64" : null;
  if (arch === null) return null;
  if (input.platform === "darwin") return `darwin-${arch}`;
  if (input.platform === "win32") return `win32-${arch}`;
  if (input.platform === "linux") return input.musl ? `linux-${arch}-musl` : `linux-${arch}`;
  return null;
}

export function isClaudeVersion(text: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(text.trim());
}
