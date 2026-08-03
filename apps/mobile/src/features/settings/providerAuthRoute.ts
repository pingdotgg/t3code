import type { ProviderAuthAction } from "@t3tools/contracts";

export type ProviderAuthRouteParams = {
  readonly environmentId: string;
  readonly instanceId: string;
  readonly displayName: string;
  readonly action: ProviderAuthAction;
  readonly sessionId?: string;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function parseProviderAuthRouteParams(value: unknown): ProviderAuthRouteParams | null {
  if (typeof value !== "object" || value === null) return null;
  const params = value as Record<string, unknown>;
  if (
    !isNonEmptyString(params.environmentId) ||
    !isNonEmptyString(params.instanceId) ||
    !isNonEmptyString(params.displayName) ||
    (params.action !== "signIn" && params.action !== "signOut") ||
    (params.sessionId !== undefined && !isNonEmptyString(params.sessionId))
  ) {
    return null;
  }
  return {
    environmentId: params.environmentId,
    instanceId: params.instanceId,
    displayName: params.displayName,
    action: params.action,
    ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
  };
}
