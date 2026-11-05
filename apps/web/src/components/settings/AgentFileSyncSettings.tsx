import { useState } from "react";
import { useEnvironments } from "../../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { AgentFileLibrary } from "./AgentFileLibrary";
import { locationLabel, type AgentFileLocation as Location } from "./agentFileLibrary";

export function AgentFileSyncSettings() {
  const { scope } = useSettingsScope();
  return <AgentFileSyncSettingsContent key={`${scope.kind}:${scope.label}`} />;
}

function AgentFileSyncSettingsContent() {
  const { scope, environment } = useSettingsScope();
  const { environments } = useEnvironments();
  const project = scope.kind === "project" || scope.kind === "checkout" ? scope.group : null;
  const locations: Location[] = project
    ? project.memberProjects.flatMap((member) => {
        const env = environments.find(
          (candidate) => candidate.environmentId === member.environmentId,
        );
        return env
          ? [
              {
                id: member.physicalProjectKey,
                environmentId: env.environmentId,
                label: env.label,
                cwd: member.workspaceRoot,
              },
            ]
          : [];
      })
    : environments.map((env) => ({
        id: env.environmentId,
        environmentId: env.environmentId,
        label: env.label,
      }));
  const sourceLocations = locations.filter(
    (location) =>
      ((scope.kind !== "environment" && scope.kind !== "project" && scope.kind !== "checkout") ||
        !scope.environmentId ||
        location.environmentId === scope.environmentId) &&
      (scope.kind !== "checkout" || location.id === scope.checkout.physicalProjectKey),
  );
  const [sourceOverride, setSource] = useState<string | null>(null);
  const source =
    sourceLocations.find((item) => item.id === sourceOverride) ??
    sourceLocations.find(
      (item) => scope.kind === "checkout" && item.id === scope.checkout.physicalProjectKey,
    ) ??
    sourceLocations.find((item) => item.environmentId === environment?.environmentId) ??
    sourceLocations[0];
  if (source && source.id !== sourceOverride) setSource(source.id);
  if (scope.kind === "unavailable")
    return (
      <SettingsPageContainer>
        <p>{scope.message}</p>
      </SettingsPageContainer>
    );
  const compatible = (target: Location) =>
    environments.find((env) => env.environmentId === target.environmentId)?.serverConfig
      ?.environment.capabilities.agentFileSync === true;
  const connected = (target: Location) =>
    environments.find((env) => env.environmentId === target.environmentId)?.connection.phase ===
    "connected";
  return (
    <SettingsPageContainer>
      <SettingsSection id="agent-file-sync" title="Skills & instructions" variant="plain">
        <div className="flex flex-col gap-5">
          <p className="text-sm text-muted-foreground">
            Browse skills and instruction files, see where they come from, and choose what to share.
          </p>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="agent-sync-source">
              Environment
            </label>
            <Select
              value={source?.id ?? null}
              onValueChange={(id) => {
                if (id) setSource(id);
              }}
              items={sourceLocations.map((item) => ({
                value: item.id,
                label: locationLabel(item),
              }))}
            >
              <SelectTrigger id="agent-sync-source" aria-label="Environment">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {sourceLocations.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {locationLabel(item)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-xs text-muted-foreground">
              {project
                ? "Project and global files on this environment. Use the scope above to switch projects."
                : "Global files in this environment’s home folder. Choose a project above to see its files too."}
            </p>
          </div>
          {source && compatible(source) && connected(source) ? (
            <AgentFileLibrary
              key={`${source.id}:${source.cwd ?? "home"}`}
              source={source}
              destinations={locations.filter((item) => item.id !== source.id)}
              globalLocations={environments.map((env) => ({
                id: env.environmentId,
                environmentId: env.environmentId,
                label: env.label,
              }))}
              compatible={compatible}
              connected={connected}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {source && !connected(source)
                ? "Connect this environment to view its files."
                : "Update this environment to view skills and instructions."}
            </p>
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
