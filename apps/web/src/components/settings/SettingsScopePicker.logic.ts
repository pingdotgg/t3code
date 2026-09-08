import type { EnvironmentPresentation } from "../../state/environments";

type ScopeEnvironment = Pick<EnvironmentPresentation, "environmentId" | "label" | "displayUrl">;

export function settingsScopeEnvironmentLabel(
  environment: ScopeEnvironment,
  environments: readonly ScopeEnvironment[],
) {
  const duplicate = environments.some(
    (other) =>
      other.environmentId !== environment.environmentId && other.label === environment.label,
  );
  return duplicate
    ? `${environment.label} · ${environment.displayUrl ?? environment.environmentId}`
    : environment.label;
}
