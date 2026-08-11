export type ThreadEnvironmentActivationAction = "enable" | "retry";

export function threadEnvironmentActivationAction(
  enabled: boolean,
): ThreadEnvironmentActivationAction {
  return enabled ? "retry" : "enable";
}
