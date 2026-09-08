import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { useEnvironments } from "../../state/environments";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { SettingsScopePicker } from "./SettingsScopePicker";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

export function ProjectsSettings({
  value,
  onScopeChange,
}: {
  value: SettingsScopeSearch;
  onScopeChange: (scope: SettingsScopeSearch) => void;
}) {
  const groups = useSettingsProjectGroups();
  const { environments } = useEnvironments();
  const scope = resolveSettingsScope(value, groups, environments);
  // The panel follows remembered members when grouping replaces a project key.
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scrollbar-gutter-both shrink-0 overflow-y-auto">
        <WorkspacePageContainer className="items-start pb-0">
          <SettingsScopePicker
            value={value}
            groups={groups}
            environments={environments}
            onChange={onScopeChange}
          />
        </WorkspacePageContainer>
      </div>
      {value.project && projectScope ? (
        <ProjectSettingsPanel
          projectKey={value.project}
          environmentId={value.machine ? EnvironmentId.make(value.machine) : null}
          checkoutKey={value.checkout ?? null}
        />
      ) : scope.kind === "unavailable" ? (
        <p className="p-8 text-sm text-muted-foreground">{scope.message}</p>
      ) : scope.kind === "device" ? (
        <p className="p-8 text-sm text-muted-foreground">
          Select an environment or project to configure project settings.
        </p>
      ) : (
        <ProjectDefaultsSettings
          environmentId={scope.kind === "environment" ? scope.environmentId : null}
        />
      )}
    </div>
  );
}
import { EnvironmentId } from "@t3tools/contracts";
