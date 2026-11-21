import { EnvironmentId } from "@lathe/contracts";
import { T, useGT } from "gt-react";
import { LayersIcon } from "lucide-react";

import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { ProjectSyncSettings } from "./ProjectSyncSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsPageContainer } from "./settingsLayout";
import { ALL_ENVIRONMENTS_VALUE, selectEnvironmentAxis } from "./settingsScopeAxis";

/**
 * Sync imports into one environment's database, so it needs exactly one
 * machine. A single-environment selection names it, whether that came from the
 * environment axis or from an "all environments" scope with one machine in it;
 * a wider selection asks for a destination instead.
 */
function ProjectSyncSection() {
  const gt = useGT();
  const { scope, selectScope } = useSettingsScope();
  const { environments } = useEnvironments();
  const syncEnvironmentId = scope.environmentIds.length === 1 ? scope.environmentIds[0] : undefined;
  if (syncEnvironmentId)
    return <ProjectSyncSettings key={syncEnvironmentId} environmentId={syncEnvironmentId} />;
  return (
    <section
      aria-label={gt("Sync from another T3 install")}
      className="space-y-3 rounded-lg border border-border/60 p-4"
    >
      <div>
        <h3 className="text-sm font-medium">
          <T>Sync from another T3 install</T>
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          <T>
            Choose the machine running your fork. Projects and conversation history are imported
            from another T3 install on that machine.
          </T>
        </p>
      </div>
      <label className="flex flex-col items-start gap-1 text-xs text-muted-foreground">
        <T>Destination machine</T>
        <select
          value=""
          disabled={environments.length === 0}
          className="max-w-full rounded-md border border-input bg-background p-2 text-sm text-foreground"
          onChange={(event) => {
            if (event.target.value) selectScope({ machine: event.target.value });
          }}
        >
          <option value="" disabled>
            {environments.length === 0
              ? gt("Connect a machine to set up sync")
              : gt("Choose a machine")}
          </option>
          {environments.map((environment) => (
            <option key={environment.environmentId} value={environment.environmentId}>
              {environment.label}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

export function ProjectsSettings() {
  const gt = useGT();
  const { search: value, scope, selectScope } = useSettingsScope();
  const unavailable =
    scope.kind === "unavailable" ? (
      <SettingsPageContainer>
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">{scope.message}</p>
          {value.machine || value.checkout ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => selectScope(selectEnvironmentAxis(value, ALL_ENVIRONMENTS_VALUE))}
            >
              <LayersIcon />
              <T>Show all environments</T>
            </Button>
          ) : null}
        </div>
      </SettingsPageContainer>
    ) : null;
  // Keep the panel mounted so it can follow members when regrouping changes the project key.
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
          unavailable={unavailable}
        />
      ) : unavailable ? (
        unavailable
      ) : (
        <>
          {/* The notice sizes to its content here: its own flex-1 scroll area
              is inert inside a block wrapper, so sync owns the page scroll. */}
          <div className="shrink-0">
            <SettingsScopeNotice target="project">
              {gt("Choose a project to manage its name, icon, checkouts and actions.")}
            </SettingsScopeNotice>
          </div>
          <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer className="pt-0">
              <ProjectSyncSection />
            </WorkspacePageContainer>
          </div>
        </>
      )}
    </div>
  );
}
