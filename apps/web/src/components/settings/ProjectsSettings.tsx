import { EnvironmentId } from "@t3tools/contracts";

import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";

/** Project identity and checkout management for the selected project. */
export function ProjectsSettings() {
  const { search: value, scope } = useSettingsScope();
  // The panel follows remembered members when grouping replaces a project key.
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {value.project && projectScope ? (
        <ProjectSettingsPanel
          projectKey={value.project}
          environmentId={value.machine ? EnvironmentId.make(value.machine) : null}
          checkoutKey={value.checkout ?? null}
        />
      ) : scope.kind === "unavailable" ? (
        <p className="p-8 text-sm text-muted-foreground">{scope.message}</p>
      ) : (
        <SettingsScopeNotice target="project">
          Choose a project to manage its name, icon, checkouts and actions.
        </SettingsScopeNotice>
      )}
    </div>
  );
}
