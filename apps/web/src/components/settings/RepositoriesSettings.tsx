/**
 * Repositories settings - the T3 projects this environment knows about. The
 * icon rail has no project tree, so this page is where repositories are added
 * and removed.
 *
 * @module RepositoriesSettings
 */
import { useNavigate } from "@tanstack/react-router";
import { FolderPlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
} from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function RepositoriesSettingsPanel() {
  const navigate = useNavigate();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const [removingProjectKey, setRemovingProjectKey] = useState<string | null>(null);

  const groups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }),
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );

  const removeGroup = useCallback(
    async (projectKey: string, members: ReadonlyArray<SidebarProjectGroupMember>) => {
      setRemovingProjectKey(projectKey);
      for (const member of members) {
        const result = await deleteProject({
          environmentId: member.environmentId,
          input: { projectId: member.id },
        });
        if (result._tag === "Failure") {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not remove the repository",
              description:
                "Delete the threads in this repository first, then remove it from this list.",
            }),
          );
          break;
        }
      }
      setRemovingProjectKey(null);
    },
    [deleteProject],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="repositories"
        title="Repositories"
        headerAction={
          <Button
            size="xs"
            variant="ghost"
            onClick={() => openCommandPalette({ open: "add-project" })}
          >
            <FolderPlusIcon className="size-3.5" />
            Add repository
          </Button>
        }
      >
        {groups.length === 0 ? (
          <SettingsRow
            title="No repositories yet"
            description="Add a repository so reports have somewhere to open code."
            control={
              <Button size="sm" onClick={() => openCommandPalette({ open: "add-project" })}>
                <FolderPlusIcon className="size-4" />
                Add repository
              </Button>
            }
          />
        ) : (
          groups.map((group) => (
            <SettingsRow
              key={group.projectKey}
              title={group.displayName}
              description={group.workspaceRoot}
              control={
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void navigate({
                        to: "/projects/$projectKey",
                        params: { projectKey: group.projectKey },
                      })
                    }
                  >
                    Settings
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${group.displayName}`}
                    disabled={removingProjectKey !== null}
                    onClick={() => void removeGroup(group.projectKey, group.memberProjects)}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              }
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
