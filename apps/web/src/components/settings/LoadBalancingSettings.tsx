import {
  LOAD_PREFERENCES,
  loadPreferenceForWeight,
  type LoadPreference,
} from "@t3tools/client-runtime/load-balancing";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";

import {
  useClientSettings,
  useClientSettingsHydrated,
  updateClientSettings,
} from "~/hooks/useSettings";
import type { EnvironmentPresentation } from "~/state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { EnvironmentRow, EnvironmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { searchableSetting } from "./settingsSearch";

function preferenceLabel(preference: LoadPreference): string {
  return LOAD_PREFERENCES.find((entry) => entry.value === preference)!.label;
}

function summarizeLoadPreferences(
  environments: ReadonlyArray<Pick<EnvironmentPresentation, "environmentId" | "label">>,
  weights: Readonly<Record<string, number>>,
): string | null {
  const parts = environments.flatMap((environment) => {
    const preference = loadPreferenceForWeight(weights[environment.environmentId]);
    return preference === 50
      ? []
      : [`${environment.label} ${preferenceLabel(preference).toLowerCase()}`];
  });
  return parts.length === 0 ? null : parts.join(" · ");
}

export function LoadBalancingSettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const settings = useClientSettings((current) => ({
    loadBalancingEnabled: current.loadBalancingEnabled,
    loadBalancingWeights: current.loadBalancingWeights,
  }));
  const settingsHydrated = useClientSettingsHydrated();

  if (environments.length < 2) return null;

  const { id, title } = searchableSetting("load-balancing");
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={
        settings.loadBalancingEnabled
          ? summarizeLoadPreferences(environments, settings.loadBalancingWeights)
          : "Off"
      }
      control={
        <Switch
          aria-label="Automatically balance load"
          checked={settings.loadBalancingEnabled}
          disabled={!settingsHydrated}
          onCheckedChange={(loadBalancingEnabled) => updateClientSettings({ loadBalancingEnabled })}
        />
      }
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        New threads in shared projects start on the machine with the most free CPU and memory,
        weighted by each machine's preference.
      </p>
      {environments.map((environment) => (
        <EnvironmentRow
          key={environment.environmentId}
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          label={environment.label}
          subtitle={<EnvironmentTransportLabel environment={environment} />}
        >
          <Select
            items={LOAD_PREFERENCES}
            value={loadPreferenceForWeight(
              settings.loadBalancingWeights[environment.environmentId],
            )}
            disabled={!settingsHydrated || !settings.loadBalancingEnabled}
            onValueChange={(value) => {
              if (value === null) return;
              updateClientSettings({
                loadBalancingWeights: {
                  ...settings.loadBalancingWeights,
                  [environment.environmentId]: value,
                },
              });
            }}
          >
            <SelectTrigger
              size="xs"
              className="w-32"
              aria-label={`${environment.label} load preference`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {LOAD_PREFERENCES.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </EnvironmentRow>
      ))}
    </FoldedSettingsSection>
  );
}
