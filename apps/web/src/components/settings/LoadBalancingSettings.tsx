import { connectionStatusText } from "@t3tools/client-runtime/connection";
import type { CSSProperties } from "react";

import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import type { EnvironmentPresentation } from "~/state/environments";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function LoadBalancingSettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();

  return (
    <SettingsSection
      {...searchableSetting("load-balancing")}
      description="Preferences are saved for this client. Higher values favor a machine when it has capacity. Equal values give equal preference. Set a machine to 0 to use it only when chosen manually."
    >
      <SettingsRow
        title="Automatically balance load"
        description="Automatically choose a connected machine for new threads in shared projects. You can choose a machine in the composer."
        control={
          <Switch
            aria-label="Automatically balance load"
            checked={settings.loadBalancingEnabled}
            onCheckedChange={(loadBalancingEnabled) => updateSettings({ loadBalancingEnabled })}
          />
        }
      />
      {environments.map((environment) => {
        const weight = settings.loadBalancingWeights[environment.environmentId] ?? 50;
        const sliderId = `load-balancing-${environment.environmentId}`;
        const sliderStyle = {
          "--settings-slider-progress": `${weight}%`,
          "--settings-slider-fill-offset": `${0.5 - weight / 100}rem`,
        } as CSSProperties;

        return (
          <SettingsRow
            key={environment.environmentId}
            title={environment.label}
            description={connectionStatusText(environment.connection)}
            control={
              <div className="flex w-full items-center gap-3 sm:w-52">
                <output
                  className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                  htmlFor={sliderId}
                >
                  {weight === 0 ? "Manual" : weight}
                </output>
                <input
                  id={sliderId}
                  aria-label={`${environment.label} load preference`}
                  aria-valuetext={weight === 0 ? "Manual only" : `${weight} preference`}
                  className="settings-slider min-w-0 flex-1 disabled:opacity-50"
                  disabled={!settings.loadBalancingEnabled}
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={weight}
                  style={sliderStyle}
                  onChange={(event) => {
                    updateSettings({
                      loadBalancingWeights: {
                        ...settings.loadBalancingWeights,
                        [environment.environmentId]: Number(event.currentTarget.value),
                      },
                    });
                  }}
                />
              </div>
            }
          />
        );
      })}
    </SettingsSection>
  );
}
