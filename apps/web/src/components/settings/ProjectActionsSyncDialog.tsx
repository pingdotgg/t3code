import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { useState } from "react";

import { copyProjectScripts, projectScriptIdFromCommand } from "../../projectScripts";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { isConnectedWithConfig } from "./scopedSettings";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { useProjectScriptSettings } from "./useProjectScriptSettings";

export function ProjectActionsSyncDialog({
  group,
  initialProjectKey,
  onClose,
}: {
  group: Pick<SidebarProjectSnapshot, "memberProjects">;
  initialProjectKey: string | null;
  onClose: () => void;
}) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const writable = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const members = group.memberProjects.map((project) => ({
    project,
    environment: environments.find((entry) => entry.environmentId === project.environmentId),
  }));
  const sources = members.filter(
    (member) => member.environment && isConnectedWithConfig(member.environment),
  );
  const [sourceKey, setSourceKey] = useState(
    initialProjectKey ?? sources[0]?.project.physicalProjectKey ?? null,
  );
  const source = sources.find((member) => member.project.physicalProjectKey === sourceKey);
  const sourceSettings = source?.environment?.serverConfig?.settings;
  const scripts =
    source && sourceSettings ? resolveProjectScripts(sourceSettings, source.project) : [];
  const destinations = source
    ? members.filter((member) => member.project.environmentId !== source.project.environmentId)
    : [];
  const targets = destinations.flatMap(({ project, environment }) =>
    environment && isConnectedWithConfig(environment) && environment.serverConfig
      ? [
          {
            environmentId: environment.environmentId,
            settings: environment.serverConfig.settings,
            keybindings: environment.serverConfig.keybindings,
            project,
          },
        ]
      : [],
  );
  const canWrite =
    targets.length > 0 && targets.every((entry) => writable.has(entry.environmentId));
  const { saving, persist } = useProjectScriptSettings(targets);
  const label = (member: (typeof members)[number]) =>
    `${member.environment ? settingsScopeEnvironmentLabel(member.environment, environments) : (member.project.environmentLabel ?? member.project.environmentId)} · ${member.project.workspaceRoot ? fileBasename(member.project.workspaceRoot) : member.project.title}`;

  const sync = async () => {
    if (!source || !sourceSettings || !canWrite || saving) return;
    const existingIds = new Set([
      ...projects.flatMap((project) => project.scripts.map((script) => script.id)),
      ...environments.flatMap(({ serverConfig }) =>
        serverConfig
          ? [
              ...serverConfig.settings.defaultProjectScripts.map((script) => script.id),
              ...Object.values(serverConfig.settings.projectScriptOverrides).flatMap(
                (entry) => entry?.map((script) => script.id) ?? [],
              ),
              ...Object.values(serverConfig.settings.projectSettingsOverrides).flatMap(
                (entry) => entry.defaultProjectScripts?.map((script) => script.id) ?? [],
              ),
              ...serverConfig.keybindings.flatMap((binding) => {
                const id = projectScriptIdFromCommand(binding.command);
                return id ? [id] : [];
              }),
            ]
          : [],
      ),
    ]);
    const result = await persist((current) => {
      const copied = copyProjectScripts(scripts, current, existingIds);
      for (const script of copied) existingIds.add(script.id);
      return copied;
    });
    if (result._tag !== "Success") return;
    toastManager.add({
      type: "success",
      title: "Actions synced",
      description: `Copied ${scripts.length} ${scripts.length === 1 ? "action" : "actions"} to ${targets.length} ${targets.length === 1 ? "checkout" : "checkouts"}.`,
    });
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Sync actions</DialogTitle>
          <DialogDescription>
            Copy actions once to this project's checkouts on other connected environments. Their
            action lists will be replaced. Shortcuts aren't copied.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="sync-actions-source">Copy from</Label>
              <Select
                value={sourceKey}
                disabled={saving}
                onValueChange={(value) => setSourceKey(value)}
              >
                <SelectTrigger id="sync-actions-source">
                  <SelectValue>{source ? label(source) : "Choose a checkout"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {sources.map((member) => (
                    <SelectItem
                      key={member.project.physicalProjectKey}
                      value={member.project.physicalProjectKey}
                    >
                      {label(member)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {source ? (
                <p className="text-xs text-muted-foreground">
                  {scripts.length === 0
                    ? "This checkout has no actions. Syncing will clear the destination lists."
                    : `${scripts.length} ${scripts.length === 1 ? "action" : "actions"}: ${scripts.map((script) => script.name).join(", ")}`}
                </p>
              ) : null}
            </div>
            <div className="grid gap-2">
              <p className="text-sm font-medium">Copy to</p>
              <ul className="space-y-2 text-sm text-muted-foreground">
                {destinations.map((member) => (
                  <li key={member.project.physicalProjectKey}>
                    {label(member)}
                    {!member.environment || !isConnectedWithConfig(member.environment)
                      ? " (offline, skipped)"
                      : !writable.has(member.project.environmentId)
                        ? " (no permission to edit actions)"
                        : ""}
                  </li>
                ))}
              </ul>
              {targets.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Connect another environment with this project to sync its actions.
                </p>
              ) : null}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!source || !canWrite || saving} onClick={() => void sync()}>
            {saving ? <Spinner size="sm" /> : null}
            Sync actions
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
