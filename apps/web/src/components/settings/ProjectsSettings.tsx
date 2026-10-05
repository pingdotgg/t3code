import { EnvironmentId } from "@t3tools/contracts";

import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { ProjectsList } from "./ProjectsList";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer } from "./settingsLayout";

/** The list of every project, or one project's identity and checkouts once picked. */
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
        <SettingsPageContainer>
          <p className="text-sm text-muted-foreground">{scope.message}</p>
        </SettingsPageContainer>
      ) : (
        <ProjectsList />
      )}
    </div>
  );
}
