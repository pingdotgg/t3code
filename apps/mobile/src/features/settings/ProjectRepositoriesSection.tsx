import {
  appendTrackedFolders,
  suggestedTrackedFolders,
} from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  PROJECT_TRACKED_FOLDERS_MAX,
  type ProjectTrackedFolder,
  type WorkspaceFolderState,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { filesystemEnvironment } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

const FOLDER_STATE_LABELS: Record<WorkspaceFolderState, string> = {
  git: "Git repository",
  plain: "Folder",
  missing: "Missing",
};

/** Tracked folders are paths on one environment, so each checkout gets its own section. */
export function ProjectRepositoriesSection(props: {
  readonly member: EnvironmentProject;
  readonly title: string;
}) {
  const { member } = props;
  const tracked = member.trackedFolders ?? [];
  const canEdit = useEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope);
  const canReadFiles = useEnvironmentScope(member.environmentId, AuthFilesystemReadScope);
  // Read from disk: the project's own copy of the list can be a moment behind a clone.
  const listQuery = useEnvironmentQuery(
    canReadFiles
      ? filesystemEnvironment.listFolders({
          environmentId: member.environmentId,
          input: { projectId: member.id },
        })
      : null,
  );
  const folders: ReadonlyArray<ProjectTrackedFolder & { state?: WorkspaceFolderState }> =
    listQuery.data?.folders ?? tracked;
  // Only a workspace file's folders are offered: the rest is found without asking.
  const scanQuery = useEnvironmentQuery(
    canReadFiles
      ? filesystemEnvironment.scanFolders({
          environmentId: member.environmentId,
          input: { workspaceRoot: member.workspaceRoot },
        })
      : null,
  );
  const suggested = suggestedTrackedFolders(folders, scanQuery.data?.folders ?? []);
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const [isBusy, setIsBusy] = useState(false);
  const added = folders.filter((folder) => folder.discovered !== true);

  const save = async (next: ReadonlyArray<ProjectTrackedFolder>) => {
    setIsBusy(true);
    const result = await updateProject({
      environmentId: member.environmentId,
      input: {
        projectId: member.id,
        trackedFolders: next.map(({ path, name }) => ({ path, name })),
      },
    });
    setIsBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          "Failed to update repositories",
          error instanceof Error ? error.message : "An error occurred.",
        );
      }
      return;
    }
    listQuery.refresh();
  };

  const remove = (folder: ProjectTrackedFolder) =>
    Dialog.confirm({
      title: "Remove folder",
      message: `Agents in this project stop working in ${folder.name}. Files on disk are not touched.`,
      confirmText: "Remove",
      destructive: true,
      onConfirm: () => void save(added.filter((entry) => entry.path !== folder.path)),
    });

  const add = (folder: ProjectTrackedFolder) => {
    const next = appendTrackedFolders(added, [folder]);
    if (next === null) {
      Dialog.alert(
        "Too many folders",
        `A project can cover up to ${PROJECT_TRACKED_FOLDERS_MAX} folders.`,
      );
      return;
    }
    void save(next);
  };

  if (folders.length === 0 && suggested.length === 0) {
    return (
      <SettingsSection
        title={props.title}
        footer="Repositories inside this project's folder are part of it as soon as they are there."
      >
        {null}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={props.title}>
      {folders.map((folder) => (
        <ListRowLayout
          key={folder.path}
          icon="folder"
          label={folder.name}
          description={folder.path}
          meta={
            folder.state === undefined ? undefined : (
              <Text
                textRole="footnote"
                className={
                  folder.state === "missing" ? "text-warning-foreground" : "text-foreground-muted"
                }
              >
                {FOLDER_STATE_LABELS[folder.state]}
              </Text>
            )
          }
          accessory={
            // A repository inside the project folder is there for as long as it is on disk.
            folder.discovered === true ? undefined : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${folder.name} from the project`}
                disabled={!canEdit || isBusy}
                onPress={() => remove(folder)}
                className="rounded-full border border-border bg-card px-3 py-1.5 disabled:opacity-40"
              >
                <Text className="font-t3-medium text-xs text-danger-foreground">Remove</Text>
              </Pressable>
            )
          }
        />
      ))}
      {suggested.map((folder) => (
        <ListActionRow
          key={folder.path}
          icon="plus"
          label={`Add ${folder.name}`}
          description={`Listed in the workspace file · ${folder.path}`}
          disabled={!canEdit || isBusy}
          onPress={() => add(folder)}
        />
      ))}
    </SettingsSection>
  );
}
