import type { EnvironmentId } from "@t3tools/contracts";

/** Wait for earlier grants before choosing the settings that edits and synchronization use. */
export function resolveAutoSettleReferenceEnvironmentId(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly canWriteSettings: boolean | null;
  }>,
): EnvironmentId | null {
  for (const environment of environments) {
    if (environment.canWriteSettings === null) return null;
    if (environment.canWriteSettings) return environment.environmentId;
  }
  return environments[0]?.environmentId ?? null;
}

export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: "iOS only" };
}
