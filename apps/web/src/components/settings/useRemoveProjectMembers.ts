import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { planProjectRemoval } from "@t3tools/client-runtime/state/projects";
import { mapAtomCommandResult, settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useGT } from "gt-react";
import { m as resolveMessage } from "../../i18n/messages";
import { useNavigate } from "@tanstack/react-router";

import { useComposerDraftStore } from "../../composerDraftStore";
import { checkProjectAccess, reportProjectFailure } from "../../hooks/useProjectGroupUpdate";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { readLocalApi } from "../../localApi";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { readThreadShells, waitForProjectRemoval } from "../../state/entities";
import { readUnloadedThreadCount } from "../../state/olderSettledShelf";
import { projectEnvironment } from "../../state/projects";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

/**
 * Removes checkouts of a project after confirmation, moving their drafts to a remaining
 * checkout. `group` holds the checkouts in view; `allMembers` spans every machine.
 */
export function useRemoveProjectMembers({
  group,
  allMembers,
  hasOtherMembers,
  navigateAfterRemoval = true,
}: {
  group: SidebarProjectSnapshot;
  allMembers: ReadonlyArray<SidebarProjectGroupMember>;
  hasOtherMembers: boolean;
  navigateAfterRemoval?: boolean;
}) {
  const gt = useGT();
  const navigate = useNavigate({ from: "/settings" });
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });

  return async (members: ReadonlyArray<SidebarProjectGroupMember>) => {
    const threads = readThreadShells();
    if (checkProjectAccess(members, gt("Failed to remove project"))) return;
    const api = readLocalApi();
    if (!api) return;

    const { projectThreads, isWholeGroup, confirmationMessage } = planProjectRemoval(
      {
        members,
        groupMemberCount: group.memberProjects.length,
        hasOtherMembers,
        displayName: group.displayName,
        threads,
        unloadedThreadCount: readUnloadedThreadCount(members, threads),
      },
      resolveMessage,
    );
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(confirmationMessage, { variant: "destructive" }),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
    if (checkProjectAccess(members, gt("Failed to remove project"))) return;

    const draftStore = useComposerDraftStore.getState();
    const remainingMember = allMembers.find(
      (candidate) =>
        !members.some(
          (member) =>
            member.environmentId === candidate.environmentId && member.id === candidate.id,
        ),
    );
    for (const member of members) {
      if (checkProjectAccess([member], gt("Failed to remove project"))) return;
      const memberThreads = projectThreads.filter(
        (thread) => thread.environmentId === member.environmentId && thread.projectId === member.id,
      );
      const result = mapAtomCommandResult(
        await deleteProject({
          environmentId: member.environmentId,
          input: {
            projectId: member.id,
            force: true,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        reportProjectFailure(gt('Failed to remove "{title}"', { title: member.title }), result);
        return;
      }
      const projectRef = scopeProjectRef(member.environmentId, member.id);
      await waitForProjectRemoval(projectRef);
      releaseProjectDraftUploads(
        projectRef,
        memberThreads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
      );
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
      if (projectDraftThread && remainingMember) {
        draftStore.setDraftThreadContext(projectDraftThread.draftId, {
          projectRef: scopeProjectRef(remainingMember.environmentId, remainingMember.id),
          environmentSelection: "manual",
          loadBalancedEnvironmentId: null,
        });
      } else if (projectDraftThread) {
        draftStore.clearDraftThread(projectDraftThread.draftId);
      }
      draftStore.clearProjectDraftThreadId(projectRef);
    }

    if (navigateAfterRemoval && isWholeGroup && !hasOtherMembers) {
      void navigate({
        to: "/settings/projects",
        search: ({ machine }) => ({ project: undefined, machine, checkout: undefined }),
        replace: true,
      });
    }
  };
}
