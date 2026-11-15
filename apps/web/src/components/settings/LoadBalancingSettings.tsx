import { resolveEnvironmentMachineKind } from "@t3tools/contracts";

import {
  useClientSettings,
  useClientSettingsHydrated,
  updateClientSettings,
} from "~/hooks/useSettings";
import type { EnvironmentPresentation } from "~/state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useTranslation } from "react-i18next";
import { Switch } from "../ui/switch";
import { EnvironmentRow, EnvironmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { searchableSetting } from "./settingsSearch";
import { translateDynamic } from "../../i18nCore";

const preferences = [
  { value: 100, label: "loadBalancing.prefer" },
  { value: 50, label: "loadBalancing.normal" },
  { value: 25, label: "loadBalancing.lessOften" },
  { value: 0, label: "loadBalancing.manualOnly" },
] as const;

const SUMMARY_LABELS: Readonly<Record<LoadPreference, string>> = {
  100: "loadBalancing.summaryPrefer",
  50: "loadBalancing.summaryNormal",
  25: "loadBalancing.summaryLessOften",
  0: "loadBalancing.summaryManualOnly",
};

type LoadPreference = (typeof preferences)[number]["value"];

function loadPreferenceForWeight(weight: number | undefined): LoadPreference {
  if (weight === undefined || weight === 50) return 50;
  if (weight === 0) return 0;
  return weight < 50 ? 25 : 100;
}

function preferenceLabel(preference: LoadPreference): string {
  return preferences.find((entry) => entry.value === preference)!.label;
}

function summarizeLoadPreferences(
  environments: ReadonlyArray<Pick<EnvironmentPresentation, "environmentId" | "label">>,
  weights: Readonly<Record<string, number>>,
): string | null {
  const parts = environments.flatMap((environment) => {
    const preference = loadPreferenceForWeight(weights[environment.environmentId]);
    return preference === 50
      ? []
      : [`${environment.label} ${translateDynamic(SUMMARY_LABELS[preference])}`];
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
  const { t } = useTranslation("settings");

  if (environments.length < 2) return null;

  const { id, title } = searchableSetting("load-balancing");
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={
        settings.loadBalancingEnabled
          ? summarizeLoadPreferences(environments, settings.loadBalancingWeights)
          : t("loadBalancing.off")
      }
      control={
        <Switch
          aria-label={t("loadBalancing.toggleAria")}
          checked={settings.loadBalancingEnabled}
          disabled={!settingsHydrated}
          onCheckedChange={(loadBalancingEnabled) => updateClientSettings({ loadBalancingEnabled })}
        />
      }
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        {t("loadBalancing.description")}
      </p>
      {environments.map((environment) => {
        const preference = loadPreferenceForWeight(
          settings.loadBalancingWeights[environment.environmentId],
        );
        return (
          <EnvironmentRow
            key={environment.environmentId}
            kind={resolveEnvironmentMachineKind(environment.serverConfig)}
            label={environment.label}
            subtitle={<EnvironmentTransportLabel environment={environment} />}
          >
            <Select
              value={preference}
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
                aria-label={t("loadBalancing.preferenceAria", { label: environment.label })}
              >
                <SelectValue>{translateDynamic(preferenceLabel(preference))}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {preferences.map(({ value, label }) => (
                  <SelectItem key={value} value={value}>
                    {translateDynamic(label)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </EnvironmentRow>
        );
      })}
    </FoldedSettingsSection>
  );
}
