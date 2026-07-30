/**
 * Wires thread shell state into the Forma thread-attention notifier.
 *
 * Watches every connected environment's thread shells and raises a
 * notification the first time a thread starts waiting on an approval or a
 * user-input request while the window is backgrounded. Mounted once at the
 * app root.
 */
import { useEffect } from "react";

import type { EnvironmentId } from "@t3tools/contracts";

import {
  reconcileThreadAttentionShellSnapshot,
  type ThreadAttentionShellUpsert,
} from "../threadAttentionNotifications";
import { useThreadShells } from "../state/entities";
import { useClientSettings } from "./useSettings";

export function useThreadAttentionNotifications(): void {
  const threadShells = useThreadShells();
  const desktopNotifyOnApprovalRequests = useClientSettings(
    (settings) => settings.desktopNotifyOnApprovalRequests,
  );
  const desktopNotifyOnUserInputRequests = useClientSettings(
    (settings) => settings.desktopNotifyOnUserInputRequests,
  );

  useEffect(() => {
    if (!desktopNotifyOnApprovalRequests && !desktopNotifyOnUserInputRequests) {
      return;
    }

    const threadsByEnvironment = new Map<EnvironmentId, ThreadAttentionShellUpsert[]>();
    for (const shell of threadShells) {
      if (shell.archivedAt !== null) {
        continue;
      }
      const upsert: ThreadAttentionShellUpsert = {
        environmentId: shell.environmentId,
        threadId: shell.id,
        threadTitle: shell.title,
        hasPendingApprovals: shell.hasPendingApprovals,
        hasPendingUserInput: shell.hasPendingUserInput,
      };
      const existing = threadsByEnvironment.get(shell.environmentId);
      if (existing) {
        existing.push(upsert);
      } else {
        threadsByEnvironment.set(shell.environmentId, [upsert]);
      }
    }

    const settings = {
      desktopNotifyOnApprovalRequests,
      desktopNotifyOnUserInputRequests,
    };
    for (const [environmentId, threads] of threadsByEnvironment) {
      reconcileThreadAttentionShellSnapshot(environmentId, threads, settings);
    }
  }, [threadShells, desktopNotifyOnApprovalRequests, desktopNotifyOnUserInputRequests]);
}
