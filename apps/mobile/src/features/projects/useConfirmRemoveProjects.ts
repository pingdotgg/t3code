import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";
import { Alert } from "react-native";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { buildRemoveProjectsConfirmation, type RemoveProjectsConfirmation } from "./remove-project";

function confirmRemoval(confirmation: RemoveProjectsConfirmation): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.env.EXPO_OS === "ios") {
      Alert.alert(
        confirmation.title,
        confirmation.message,
        [
          { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
          { text: confirmation.confirmText, style: "destructive", onPress: () => resolve(true) },
        ],
        { onDismiss: () => resolve(false) },
      );
      return;
    }
    showConfirmDialog({
      title: confirmation.title,
      message: confirmation.message,
      confirmText: confirmation.confirmText,
      destructive: true,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

/**
 * Confirms and removes project entries from their environments. The server
 * deletes the projects' threads along the way (`force`), so the confirmation
 * spells out how many threads go with them. Resolves true once every member
 * is gone, false when the user backs out or a removal fails.
 */
export function useConfirmRemoveProjects(): (
  members: ReadonlyArray<EnvironmentProject>,
  options: { readonly groupTitle: string; readonly isWholeGroup: boolean },
) => Promise<boolean> {
  const threads = useThreadShells();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });

  return useCallback(
    async (members, options) => {
      if (members.length === 0) return false;
      const memberKeys = new Set(
        members.map((member) => scopedProjectKey(member.environmentId, member.id)),
      );
      const threadCount = threads.filter((thread) =>
        memberKeys.has(scopedProjectKey(thread.environmentId, thread.projectId)),
      ).length;
      const confirmed = await confirmRemoval(
        buildRemoveProjectsConfirmation({
          members: members.map((member) => ({
            ...member,
            environmentLabel: savedConnectionsById[member.environmentId]?.environmentLabel ?? null,
          })),
          groupTitle: options.groupTitle,
          isWholeGroup: options.isWholeGroup,
          threadCount,
        }),
      );
      if (!confirmed) return false;

      for (const member of members) {
        const result = await deleteProject({
          environmentId: member.environmentId,
          input: { projectId: member.id, force: true },
        });
        if (AsyncResult.isFailure(result)) {
          const error = Cause.squash(result.cause);
          Alert.alert(
            `Failed to remove “${member.title}”`,
            error instanceof Error ? error.message : "An error occurred.",
          );
          return false;
        }
      }
      return true;
    },
    [deleteProject, savedConnectionsById, threads],
  );
}
