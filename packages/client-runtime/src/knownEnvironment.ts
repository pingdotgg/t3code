import type { EnvironmentId } from "@t3tools/contracts";

export interface KnownEnvironmentConnectionTarget {
  readonly type: "ws";
  readonly wsUrl: string;
}

export type KnownEnvironmentSource = "configured" | "desktop-managed" | "manual" | "window-origin";

export interface KnownEnvironment {
  readonly id: string;
  readonly label: string;
  readonly source: KnownEnvironmentSource;
  readonly environmentId?: EnvironmentId;
  readonly target: KnownEnvironmentConnectionTarget;
}

export function createKnownEnvironmentFromWsUrl(input: {
  readonly id?: string;
  readonly label: string;
  readonly source?: KnownEnvironmentSource;
  readonly wsUrl: string;
}): KnownEnvironment {
  return {
    id: input.id ?? `ws:${input.label}`,
    label: input.label,
    source: input.source ?? "manual",
    target: {
      type: "ws",
      wsUrl: input.wsUrl,
    },
  };
}

export function getKnownEnvironmentBaseUrl(
  environment: KnownEnvironment | null | undefined,
): string | null {
  return environment?.target.wsUrl ?? null;
}
