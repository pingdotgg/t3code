import { msg } from "gt-react";
import { m, type MessageResolver } from "../i18n/messages";
import type {
  EnvironmentId,
  ManagedPolicySummary,
  ProviderDriverKind,
  ServerConfig,
} from "@t3tools/contracts";
import { APP_NAME } from "@t3tools/shared/branding";

import { useServerConfigs } from "./entities";
import { usePrimaryEnvironmentId } from "./environments";

/** The policy an environment's administrator applies, or undefined when it is unmanaged. */
export function useManagedPolicy(
  environmentId: EnvironmentId | null | undefined,
): ManagedPolicySummary | undefined {
  const serverConfigs = useServerConfigs();
  return environmentId == null ? undefined : serverConfigs.get(environmentId)?.managedPolicy;
}

export function usePrimaryManagedPolicy(): ManagedPolicySummary | undefined {
  return useManagedPolicy(usePrimaryEnvironmentId());
}

/**
 * Why a control acting on several environments is unavailable: the first denial any target's
 * policy gives, since one refusing target refuses the whole action.
 */
export function firstManagedDenial(
  policies: Iterable<ManagedPolicySummary | undefined>,
  deny: (policy: ManagedPolicySummary | undefined) => string | undefined,
): string | undefined {
  for (const policy of policies) {
    const denial = deny(policy);
    if (denial !== undefined) return denial;
  }
  return undefined;
}

/**
 * What usage-data notices say. This server never sends any; older servers report `telemetryEnabled`,
 * or omit it and may send by default.
 */
export function usageDataNotice(
  config: Pick<ServerConfig, "telemetryEnabled"> | undefined,
): string {
  switch (config?.telemetryEnabled) {
    case false:
      return `${APP_NAME} doesn't collect usage data.`;
    case true:
      return "This server sends anonymous usage data because T3CODE_TELEMETRY_ENABLED is on. Update it to stop.";
    default:
      return "This server may send anonymous usage data. Update it, or set T3CODE_TELEMETRY_ENABLED=false on it.";
  }
}

export function useUsageDataNotice(environmentId: EnvironmentId | null | undefined): string {
  const serverConfigs = useServerConfigs();
  return usageDataNotice(environmentId == null ? undefined : serverConfigs.get(environmentId));
}

export interface ManagedInstanceLocks {
  /** Keys inside the instance's `config` users cannot change. */
  readonly configKeys: ReadonlySet<string>;
  /** Environment variables users cannot edit, rename, or remove. */
  readonly environmentNames: ReadonlySet<string>;
  /** Under a runtime-mode ceiling every variable is the administrator's, not only named ones. */
  readonly wholeEnvironment: boolean;
  readonly reason: string;
}

/** What the policy pins on instances of `driver`, or undefined when nothing is. */
export function managedInstanceLocks(
  policy: ManagedPolicySummary | undefined,
  driver: ProviderDriverKind,
  resolve: MessageResolver = m,
): ManagedInstanceLocks | undefined {
  const paths = policy?.limits?.providers?.lockedInstanceFields?.[driver];
  if (policy === undefined || paths === undefined || paths.length === 0) return undefined;
  const fieldsUnder = (prefix: string) =>
    new Set(paths.flatMap((path) => (path.startsWith(prefix) ? [path.slice(prefix.length)] : [])));
  return {
    configKeys: fieldsUnder("config."),
    environmentNames: fieldsUnder("environment."),
    wholeEnvironment: paths.includes("environment"),
    reason: resolve(msg("Managed by {organization}.", { organization: policy.organization })),
  };
}
