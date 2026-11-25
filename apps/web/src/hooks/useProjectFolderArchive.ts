// Fork: archives a sidebar project folder as a whole, the project and its threads.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { msg } from "gt-react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { readLocalApi } from "../localApi";
import { readThreadShells } from "../state/entities";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { useProjectGroupUpdate } from "./useProjectGroupUpdate";
import { useThreadActions } from "./useThreadActions";

function projectThreads(group: SidebarProjectSnapshot): readonly EnvironmentThreadShell[] {
  return readThreadShells().filter(
    (thread) =>
      thread.archivedAt === null &&
      group.memberProjects.some(
        (member) => member.environmentId === thread.environmentId && member.id === thread.projectId,
      ),
  );
}

export function useProjectFolderArchive() {
  const { updateProjectGroup, canOrganizeProjectGroup } = useProjectGroupUpdate();
  const { archiveThread } = useThreadActions();

  const archiveProjectFolder = async (group: SidebarProjectSnapshot) => {
    const api = readLocalApi();
    if (!api) return;
    const threads = projectThreads(group);
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        m(
          msg(
            '{count, plural, =0 {Archive "{project}"?} one {Archive "{project}" and its thread?} other {Archive "{project}" and its # threads?}}\n\nThreads move to Settings → Archived, and the project can be unarchived from its settings.',
            { project: group.displayName, count: threads.length },
          ),
        ),
      ),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;

    const result = await updateProjectGroup(
      group.memberProjects,
      { archived: true },
      m(msg("Failed to archive project")),
    );
    if (result._tag === "Failure") return;

    // A running thread cannot be archived; it stays in the folder until it finishes.
    let kept = 0;
    for (const thread of threads) {
      if (!threadRuntimeCanArchive(thread.runtime)) {
        kept += 1;
        continue;
      }
      const archived = await archiveThread(scopeThreadRef(thread.environmentId, thread.id));
      if (archived._tag === "Failure") kept += 1;
    }
    if (kept > 0) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: m(
            msg(
              "{count, plural, one {# thread was not archived. It may still be running.} other {# threads were not archived. They may still be running.}}",
              { count: kept },
            ),
          ),
        }),
      );
    }
  };

  const unarchiveProjectFolder = (group: SidebarProjectSnapshot) =>
    updateProjectGroup(
      group.memberProjects,
      { archived: false },
      m(msg("Failed to unarchive project")),
    );

  return {
    canArchiveProjectFolder: (group: SidebarProjectSnapshot) =>
      canOrganizeProjectGroup(group.memberProjects),
    archiveProjectFolder,
    unarchiveProjectFolder,
  };
}
