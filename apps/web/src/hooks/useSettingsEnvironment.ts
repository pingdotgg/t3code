import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";

import { resolveSettingsEnvironmentId } from "../components/settings/SettingsPanels.logic";
import { useActiveEnvironmentId } from "../state/entities";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../state/environments";
import {
  selectedSettingsEnvironmentIdAtom,
  setSelectedSettingsEnvironmentId,
} from "../state/settingsEnvironment";

export interface SettingsEnvironmentTarget {
  readonly isReady: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly environment: EnvironmentPresentation | null;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly selectEnvironment: (environmentId: EnvironmentId) => void;
}

/**
 * Resolve the server environment configured by a settings surface.
 *
 * Managed clients retain their historical primary-server behavior. Clients
 * without a managed backend start with the currently active saved
 * environment, then fall back to the first available environment.
 */
export function useSettingsEnvironment(): SettingsEnvironmentTarget {
  const { isReady, environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useActiveEnvironmentId();
  const selectedEnvironmentId = useAtomValue(selectedSettingsEnvironmentIdAtom);
  const environmentId = resolveSettingsEnvironmentId({
    availableEnvironmentIds: environments.map((environment) => environment.environmentId),
    selectedEnvironmentId,
    primaryEnvironmentId,
    activeEnvironmentId,
  });
  const environment =
    environmentId === null
      ? null
      : (environments.find((candidate) => candidate.environmentId === environmentId) ?? null);

  return {
    isReady,
    environmentId,
    environment,
    environments,
    primaryEnvironmentId,
    selectEnvironment: setSelectedSettingsEnvironmentId,
  };
}
