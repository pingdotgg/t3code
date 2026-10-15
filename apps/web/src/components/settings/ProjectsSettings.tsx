import { EnvironmentId } from "@t3tools/contracts";
import { LayersIcon } from "lucide-react";

import { Button } from "../ui/button";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { ALL_ENVIRONMENTS_VALUE, selectEnvironmentAxis } from "./settingsScopeAxis";
import { SettingsPageContainer } from "./settingsLayout";

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
          unavailable={scope.kind === "unavailable" ? <ProjectScopeUnavailable /> : null}
        />
      ) : scope.kind === "unavailable" ? (
        <SettingsPageContainer>
          <p className="text-sm text-muted-foreground">{scope.message}</p>
        </SettingsPageContainer>
      ) : (
        <SettingsScopeNotice target="project">
          Choose a project to manage its name, icon, checkouts and actions.
        </SettingsScopeNotice>
      )}
    </div>
  );
}

/**
 * The picked project has no checkout matching the environment or checkout
 * axis, usually from a stale link. The scope sentence stays on screen so the
 * selection can be changed, and one click widens it back to every environment.
 */
function ProjectScopeUnavailable() {
  const { scope, search, selectScope } = useSettingsScope();
  if (scope.kind !== "unavailable") return null;
  return (
    <SettingsPageContainer>
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">{scope.message}</p>
        {search.machine ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() => selectScope(selectEnvironmentAxis(search, ALL_ENVIRONMENTS_VALUE))}
          >
            <LayersIcon />
            Show all environments
          </Button>
        ) : null}
      </div>
    </SettingsPageContainer>
  );
}
