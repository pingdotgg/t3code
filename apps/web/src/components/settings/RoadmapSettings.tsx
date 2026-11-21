import {
  AuthAccessWriteScope,
  EnvironmentId,
  type RoadmapArea,
  type RoadmapAreaSettings,
  type RoadmapUnit,
} from "@lathe/contracts";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { readEnvironmentScope, readPreparedConnection } from "~/state/session";
import { RoadmapLinkSection } from "./RoadmapLinkSettings";
import { RoadmapStewardModelRow } from "./RoadmapStewardModelRow";
import { useLinkToRoadmapHome } from "./useRoadmapLink";
import { useEnvironments } from "~/state/environments";
import {
  readRoadmapLinkSupported,
  useRoadmapAreaSettings,
  useRoadmapHome,
  useRoadmapSupported,
  useUpdateRoadmapAreaSettings,
} from "~/state/roadmap";
import {
  ROADMAP_AREA_LABELS,
  ROADMAP_AREAS,
  ROADMAP_UNIT_LABELS,
  ROADMAP_UNITS,
  ROADMAP_WEEKDAY_LABELS,
  workingWeekdaysFrom,
} from "../roadmap/roadmap.logic";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const THIS_ENVIRONMENT = "this";

/**
 * Fork: roadmap. Which environment owns the roadmap, and each area's unit and
 * calendar, which live on the home whichever environment Settings has selected.
 */
export function RoadmapSettingsPanel() {
  const { scope, connectedEnvironments, targets } = useSettingsScope();
  const { environments } = useEnvironments();
  const settings = useScopedSettings();
  const mixed = useScopedSettingsMixed(["roadmap"]);
  const updateSettings = useUpdateScopedSettings();
  const linkToHome = useLinkToRoadmapHome();

  if (scope.kind === "project" || scope.kind === "checkout") {
    return (
      <SettingsScopeNotice target="all">
        The roadmap home is set per environment. Choose an environment to change it.
      </SettingsScopeNotice>
    );
  }
  const eligibleEnvironmentIds = connectedEnvironments
    .filter((environment) => environment.serverConfig?.environment.capabilities.roadmap === true)
    .map((environment) => environment.environmentId);
  if (eligibleEnvironmentIds.length < connectedEnvironments.length) {
    return (
      <SettingsScopeNotice target="environment" eligibleEnvironmentIds={eligibleEnvironmentIds}>
        Update the selected environments to use the roadmap, or choose one that supports it.
      </SettingsScopeNotice>
    );
  }

  // With one target, choosing that target is the same as "This environment".
  const ownId = targets.length === 1 ? targets[0]!.environmentId : null;
  const options = environments.filter((environment) => environment.environmentId !== ownId);
  const labels: Record<string, string> = {
    [THIS_ENVIRONMENT]: "This environment",
    ...Object.fromEntries(
      options.map((environment) => [environment.environmentId, environment.label]),
    ),
  };
  const homeId = settings.roadmap.homeEnvironmentId;
  const ownLabel =
    environments.find((environment) => environment.environmentId === ownId)?.label ?? ownId ?? "";
  const value = mixed ? null : homeId === null || homeId === ownId ? THIS_ENVIRONMENT : homeId;

  const choose = async (next: string) => {
    const homeEnvironmentId = next === THIS_ENVIRONMENT ? null : EnvironmentId.make(next);
    if (!mixed && homeEnvironmentId === homeId) return;
    const confirmed = await requestConfirmDialog(
      "Change the roadmap home?\nThe roadmap does not move with it. Work items stay where they are, and the new home shows its own roadmap. Moving a roadmap between environments arrives in a later release.",
    );
    if (confirmed !== true) return;
    updateSettings({ roadmap: { homeEnvironmentId } });
    // Choosing another environment as the home links this one to it, when the
    // client may and knows an address; otherwise the link row below is there.
    if (ownId === null || homeEnvironmentId === null || homeEnvironmentId === ownId) return;
    const homeUrl = readPreparedConnection(homeEnvironmentId)?.httpBaseUrl;
    if (
      homeUrl !== undefined &&
      readRoadmapLinkSupported(ownId) &&
      readRoadmapLinkSupported(homeEnvironmentId) &&
      readEnvironmentScope(ownId, AuthAccessWriteScope) &&
      readEnvironmentScope(homeEnvironmentId, AuthAccessWriteScope)
    ) {
      void linkToHome({
        environmentId: ownId,
        environmentLabel: ownLabel,
        home: homeEnvironmentId,
        homeUrl,
      });
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Roadmap">
        <SettingsRow
          serverScoped
          settingKeys={["roadmap"]}
          {...searchableSetting("roadmap-home")}
          description="The environment whose database holds the roadmap. Every client reads and changes work items there."
          control={
            <Select
              value={value}
              items={labels}
              onValueChange={(next) => {
                if (next !== null) void choose(next);
              }}
            >
              <SelectTrigger size="sm" aria-label="Roadmap home">
                <SelectValue>
                  {(current: string | null) =>
                    current === null ? "Mixed" : (labels[current] ?? "Unknown environment")
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={THIS_ENVIRONMENT}>This environment</SelectItem>
                {options.map((environment) => (
                  <SelectItem key={environment.environmentId} value={environment.environmentId}>
                    {environment.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        {ownId !== null && !mixed && homeId !== null && homeId !== ownId ? (
          <RoadmapLinkSection environmentId={ownId} environmentLabel={ownLabel} home={homeId} />
        ) : null}
        <RoadmapStewardModelRow />
      </SettingsSection>
      <RoadmapAreaSections />
    </SettingsPageContainer>
  );
}

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function RoadmapAreaSections() {
  const home = useRoadmapHome();
  const supported = useRoadmapSupported(home);
  const areas = useRoadmapAreaSettings(home);
  const update = useUpdateRoadmapAreaSettings(home);
  if (!supported) return null;
  return ROADMAP_AREAS.map((area, index) => (
    <RoadmapAreaSection
      key={area}
      area={area}
      settings={areas[area]}
      searchAnchor={index === 0}
      onChange={(patch) => void update(area, patch)}
    />
  ));
}

function RoadmapAreaSection({
  area,
  settings,
  searchAnchor,
  onChange,
}: {
  readonly area: RoadmapArea;
  readonly settings: RoadmapAreaSettings;
  readonly searchAnchor: boolean;
  readonly onChange: (patch: Partial<RoadmapAreaSettings>) => void;
}) {
  const label = ROADMAP_AREA_LABELS[area];
  return (
    <SettingsSection title={`${label} area`}>
      <SettingsRow
        {...(searchAnchor ? searchableSetting("roadmap-areas") : {})}
        title="Unit"
        description="What estimates, progress and velocity count. Saved on the roadmap home."
        control={
          <Select
            value={settings.unit}
            items={ROADMAP_UNIT_LABELS}
            onValueChange={(next) => {
              const unit = ROADMAP_UNITS.find((option) => option === next);
              if (unit !== undefined && unit !== settings.unit) onChange({ unit });
            }}
          >
            <SelectTrigger size="sm" aria-label={`${label} unit`}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {ROADMAP_UNITS.map((unit: RoadmapUnit) => (
                <SelectItem key={unit} value={unit}>
                  {ROADMAP_UNIT_LABELS[unit]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Working days"
        description="The days that count toward working days left, velocity and forecasts."
        control={
          <ToggleGroup
            multiple
            aria-label={`${label} working days`}
            variant="segmented"
            value={settings.workingWeekdays.map(String)}
            onValueChange={(next) => {
              const workingWeekdays = workingWeekdaysFrom(next);
              // Settings refuse an empty week, so the last day stays pressed.
              if (workingWeekdays !== null) onChange({ workingWeekdays });
            }}
          >
            {WEEKDAY_ORDER.map((day) => (
              <Toggle key={day} value={String(day)}>
                {ROADMAP_WEEKDAY_LABELS[day]}
              </Toggle>
            ))}
          </ToggleGroup>
        }
      />
      <SettingsRow
        title="Going cold"
        description="Working days without activity before a P0 or P1 item shows as going cold on Today."
        control={
          <GoingColdField
            label={`${label} going cold`}
            value={settings.goingColdDays}
            onChange={(goingColdDays) => onChange({ goingColdDays })}
          />
        }
      />
      <SettingsRow
        {...(searchAnchor ? searchableSetting("roadmap-steward") : {})}
        title="Steward"
        description="After each turn on an attached thread, ticks criteria the turn proves met, with evidence, and notes doubts. It never unticks, edits fields or marks work done. Applies to every environment."
        control={
          <Switch
            checked={settings.stewardEnabled}
            onCheckedChange={(checked) => onChange({ stewardEnabled: Boolean(checked) })}
            aria-label={`${label} steward`}
          />
        }
      />
    </SettingsSection>
  );
}

function GoingColdField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (next: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(value);
  const [shown, setShown] = useState(value);
  // A save from elsewhere replaces the draft once it arrives.
  if (shown !== value) {
    setShown(value);
    setDraft(value);
  }
  return (
    <NumberField
      value={draft}
      min={1}
      max={365}
      step={1}
      size="sm"
      onValueChange={setDraft}
      onValueCommitted={(next) => {
        if (next === null) return setDraft(value);
        const days = Math.min(365, Math.max(1, Math.round(next)));
        setDraft(days);
        if (days !== value) onChange(days);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Decrease ${label}`} />
        <NumberFieldInput aria-label={`${label} in working days`} />
        <NumberFieldIncrement aria-label={`Increase ${label}`} />
      </NumberFieldGroup>
    </NumberField>
  );
}
