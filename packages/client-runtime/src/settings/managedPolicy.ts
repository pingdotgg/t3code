import type { ManagedPolicySummary, ProviderDriverKind } from "@t3tools/contracts";

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
): ManagedInstanceLocks | undefined {
  const paths = policy?.limits?.providers?.lockedInstanceFields?.[driver];
  if (policy === undefined || paths === undefined || paths.length === 0) return undefined;
  const fieldsUnder = (prefix: string) =>
    new Set(paths.flatMap((path) => (path.startsWith(prefix) ? [path.slice(prefix.length)] : [])));
  return {
    configKeys: fieldsUnder("config."),
    environmentNames: fieldsUnder("environment."),
    wholeEnvironment: paths.includes("environment"),
    reason: `Managed by ${policy.organization}.`,
  };
}
