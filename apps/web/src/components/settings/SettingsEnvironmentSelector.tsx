import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CloudIcon, MonitorIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { useSettingsEnvironment } from "../../hooks/useSettingsEnvironment";
import type { EnvironmentPresentation } from "../../state/environments";
import { Button } from "../ui/button";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { settingsEnvironmentNotice } from "./SettingsPanels.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

interface SettingsEnvironmentSelectorProps {
  readonly environmentId: EnvironmentId;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
}

export function SettingsEnvironmentSelector({
  environmentId,
  environments,
  primaryEnvironmentId,
  onEnvironmentChange,
}: SettingsEnvironmentSelectorProps) {
  const items = useMemo(
    () =>
      environments.map((environment) => ({
        value: environment.environmentId,
        label: environment.label,
      })),
    [environments],
  );
  const selectedEnvironment =
    environments.find((environment) => environment.environmentId === environmentId) ?? null;
  const SelectedIcon = environmentId === primaryEnvironmentId ? MonitorIcon : CloudIcon;

  return (
    <Select
      value={environmentId}
      items={items}
      onValueChange={(value) => onEnvironmentChange(value as EnvironmentId)}
    >
      <SelectTrigger size="sm" className="w-36 sm:w-52" aria-label="Settings environment">
        <SelectedIcon className="size-3.5" />
        <SelectValue>{selectedEnvironment?.label ?? "Select environment"}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectGroup>
          <SelectGroupLabel>Configure environment</SelectGroupLabel>
          {environments.map((environment) => {
            const Icon =
              environment.environmentId === primaryEnvironmentId ? MonitorIcon : CloudIcon;
            return (
              <SelectItem key={environment.environmentId} value={environment.environmentId}>
                <span className="inline-flex items-center gap-1.5">
                  <Icon className="size-3.5" />
                  {environment.label}
                </span>
              </SelectItem>
            );
          })}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
}

/**
 * Header for a panel whose contents belong to one environment: the picker, the
 * current target, and why that target is unusable. `children` only renders
 * against an environment that has published its settings, so panels never show
 * schema defaults as if they were saved.
 */
export function SettingsEnvironmentScope({
  description,
  children,
}: {
  readonly description: string;
  readonly children: (
    environment: EnvironmentPresentation,
    serverConfig: ServerConfig,
  ) => ReactNode;
}) {
  const {
    isReady,
    environment,
    environmentId,
    environments,
    primaryEnvironmentId,
    selectEnvironment,
  } = useSettingsEnvironment();
  const serverConfig = environment?.serverConfig ?? null;
  const notice = settingsEnvironmentNotice({
    isReady,
    label: environment?.label ?? null,
    phase: environment?.connection.phase ?? null,
    hasServerConfig: serverConfig !== null,
    error: environment?.connection.error ?? null,
  });

  return (
    <>
      <SettingsSection
        title="Environment"
        headerAction={
          environmentId === null ? null : (
            <SettingsEnvironmentSelector
              environmentId={environmentId}
              environments={environments}
              primaryEnvironmentId={primaryEnvironmentId}
              onEnvironmentChange={selectEnvironment}
            />
          )
        }
      >
        <SettingsRow
          title={environment?.label ?? "No environment"}
          description={description}
          status={notice ?? environment?.displayUrl}
          control={
            isReady && environmentId === null ? (
              <Button render={<Link to="/settings/connections" />} size="sm" variant="outline">
                Open connections
              </Button>
            ) : null
          }
        />
      </SettingsSection>
      {environment !== null && serverConfig !== null && notice === null
        ? children(environment, serverConfig)
        : null}
    </>
  );
}
