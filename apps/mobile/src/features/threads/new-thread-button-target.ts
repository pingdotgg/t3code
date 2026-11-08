import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import type { NewThreadButtonTarget } from "@t3tools/contracts/settings";

export const DEFAULT_NEW_THREAD_BUTTON_TARGET: NewThreadButtonTarget = "pick-project";

export const NEW_THREAD_BUTTON_TARGET_OPTIONS: ReadonlyArray<{
  readonly value: NewThreadButtonTarget;
  readonly label: string;
}> = [
  { value: "pick-project", label: "Choose a project" },
  { value: "no-project", label: "No project" },
];

/**
 * The environment a New thread press starts a No project thread on, or null to open the picker.
 * As on desktop: only with "No project" chosen, and only on a connected server that offers No
 * project folders. The current or last-used environment wins; otherwise a sole offering one.
 */
export function resolveNewThreadButtonScratchEnvironment(input: {
  readonly target: NewThreadButtonTarget | undefined;
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "scratchWorkspaceRoot">>;
  readonly preferredEnvironmentIds: ReadonlyArray<string | null | undefined>;
}): EnvironmentId | null {
  if (input.target !== "no-project") return null;
  // Every id here is connected already, so only the server config decides.
  const offering = input.connectedEnvironmentIds.filter(
    (environmentId) =>
      availableScratchWorkspaceRoot("connected", input.serverConfigs.get(environmentId)) !== null,
  );
  for (const preferred of input.preferredEnvironmentIds) {
    const match = offering.find((environmentId) => environmentId === preferred);
    if (match !== undefined) return match;
  }
  return offering.length === 1 ? (offering[0] ?? null) : null;
}
