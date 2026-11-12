import {
  appendTrackedFolders,
  trackedFoldersFromSelection,
  untrackedScannedFolders,
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
  type WorkspaceScannedFolder,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScannedFolderRows, scannedFolderCountLabel } from "../projects/ScannedFolderRows";
import { filesystemEnvironment } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
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
  const folderStates = useEnvironmentQuery(
    tracked.length === 0 || !canReadFiles
      ? null
      : filesystemEnvironment.listFolders({
          environmentId: member.environmentId,
          input: { projectId: member.id },
        }),
  );
  const stateByPath = new Map(
    folderStates.data?.folders.map((folder) => [folder.path, folder.state] as const),
  );
  const scanFolders = useAtomQueryRunner(filesystemEnvironment.scanFolders, {
    reportFailure: false,
    refresh: true,
  });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const [isBusy, setIsBusy] = useState(false);
  const [found, setFound] = useState<ReadonlyArray<WorkspaceScannedFolder> | null>(null);
  const [deselectedPaths, setDeselectedPaths] = useState<ReadonlySet<string>>(new Set());

  const save = async (trackedFolders: ReadonlyArray<ProjectTrackedFolder>) => {
    setIsBusy(true);
    const result = await updateProject({
      environmentId: member.environmentId,
      input: { projectId: member.id, trackedFolders },
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
      return false;
    }
    folderStates.refresh();
    return true;
  };

  const remove = (folder: ProjectTrackedFolder) =>
    Dialog.confirm({
      title: "Remove repository",
      message: `Agents in this project stop working in ${folder.name}. Files on disk are not touched.`,
      confirmText: "Remove",
      destructive: true,
      onConfirm: () => void save(tracked.filter((entry) => entry.path !== folder.path)),
    });

  const rescan = async () => {
    setIsBusy(true);
    const scan = await scanFolders({
      environmentId: member.environmentId,
      input: { workspaceRoot: member.workspaceRoot },
    });
    setIsBusy(false);
    folderStates.refresh();
    if (!AsyncResult.isSuccess(scan)) {
      if (!isAtomCommandInterrupted(scan)) {
        const error = squashAtomCommandFailure(scan);
        Dialog.alert(
          "Failed to scan folder",
          error instanceof Error ? error.message : "An error occurred.",
        );
      }
      return;
    }
    const untracked = untrackedScannedFolders(tracked, scan.value.folders);
    if (untracked.length === 0) {
      Dialog.alert(
        "Nothing new found",
        `No untracked repositories were found in ${member.workspaceRoot}.`,
      );
      return;
    }
    setDeselectedPaths(new Set());
    setFound(untracked);
  };

  const selected = found === null ? [] : trackedFoldersFromSelection(found, deselectedPaths);
  const addSelected = async () => {
    const next = appendTrackedFolders(tracked, selected);
    if (next === null) {
      Dialog.alert(
        "Too many repositories",
        `A project can track up to ${PROJECT_TRACKED_FOLDERS_MAX} folders. Deselect some and try again.`,
      );
      return;
    }
    if (await save(next)) setFound(null);
  };

  return (
    <>
      <SettingsSection
        title={props.title}
        footer={
          tracked.length === 0
            ? "Extra folders this project's agents can work in, besides its own folder."
            : undefined
        }
      >
        {tracked.map((folder) => {
          const state = stateByPath.get(folder.path);
          return (
            <ListRowLayout
              key={folder.path}
              icon="folder"
              label={folder.name}
              description={folder.path}
              meta={
                state === undefined ? undefined : (
                  <Text
                    textRole="footnote"
                    className={
                      state === "missing" ? "text-warning-foreground" : "text-foreground-muted"
                    }
                  >
                    {FOLDER_STATE_LABELS[state]}
                  </Text>
                )
              }
              accessory={
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove repository ${folder.name}`}
                  disabled={!canEdit || isBusy}
                  onPress={() => remove(folder)}
                  className="rounded-full border border-border bg-card px-3 py-1.5 disabled:opacity-40"
                >
                  <Text className="font-t3-medium text-xs text-danger-foreground">Remove</Text>
                </Pressable>
              }
            />
          );
        })}
        <ListActionRow
          icon="arrow.clockwise"
          label="Rescan"
          description={`Looks for repositories in ${member.workspaceRoot}`}
          disabled={!canEdit || !canReadFiles || found !== null}
          loading={isBusy && found === null}
          onPress={() => void rescan()}
        />
      </SettingsSection>
      {found === null ? null : (
        <SettingsSection title="Found by rescan">
          <ListActionRow
            icon="plus"
            label={
              selected.length === 0
                ? "Add repositories"
                : `Add ${scannedFolderCountLabel(
                    found.filter((folder) => !deselectedPaths.has(folder.path)),
                  )}`
            }
            disabled={!canEdit || selected.length === 0}
            loading={isBusy}
            onPress={() => void addSelected()}
          />
          <ListActionRow
            icon="xmark"
            label="Cancel"
            disabled={isBusy}
            onPress={() => setFound(null)}
          />
          <ScannedFolderRows
            folders={found}
            deselectedPaths={deselectedPaths}
            disabled={isBusy}
            onDeselectedPathsChange={setDeselectedPaths}
          />
        </SettingsSection>
      )}
    </>
  );
}
