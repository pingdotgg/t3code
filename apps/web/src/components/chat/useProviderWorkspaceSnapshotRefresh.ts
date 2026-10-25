import {
  type EnvironmentId,
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
  type ServerProvider,
} from "@t3tools/contracts";
import { type ProviderInstanceEntry } from "../../providerInstances";
import {
  hasCompleteProviderWorkspaceSnapshot,
  hasCurrentProviderWorkspaceSnapshot,
} from "@t3tools/client-runtime/providerSkills";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";

const WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS = 10_000;

/**
 * Keeps the selected provider's workspace snapshot fresh for the composer's
 * cwd. Returns a check to run when the user types.
 */
export function useProviderWorkspaceSnapshotRefresh(input: {
  readonly environmentId: EnvironmentId;
  readonly gitCwd: string | null;
  readonly selectedProviderEntry: ProviderInstanceEntry | undefined;
  readonly selectedProviderStatus: ServerProvider | null;
}) {
  const { environmentId, gitCwd, selectedProviderEntry, selectedProviderStatus } = input;
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  // The last scan this composer asked for. A request inside the TTL is not
  // repeated, so a client clock ahead of the server's cannot loop rescans.
  const workspaceRefreshKeyRef = useRef<{ key: string; requestedAt: number } | null>(null);
  const [workspaceRefreshRetry, setWorkspaceRefreshRetry] = useState<{
    key: string;
    notBefore: number;
  } | null>(null);
  const workspaceRefreshScopeKey =
    gitCwd && selectedProviderEntry
      ? `${environmentId}:${selectedProviderEntry.instanceId}:${gitCwd}`
      : null;
  const workspaceSlashCommandsPending =
    selectedProviderStatus?.workspaceSnapshots?.some(
      (snapshot) => snapshot.cwd === gitCwd && snapshot.slashCommandsPending === true,
    ) ?? false;
  useEffect(() => {
    if (
      !workspaceSlashCommandsPending ||
      !workspaceRefreshRetry ||
      workspaceRefreshRetry.key !== workspaceRefreshScopeKey
    )
      return;
    const timeout = setTimeout(
      () => {
        setWorkspaceRefreshRetry((current) => (current === workspaceRefreshRetry ? null : current));
      },
      Math.max(0, workspaceRefreshRetry.notBefore - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [workspaceRefreshRetry, workspaceRefreshScopeKey, workspaceSlashCommandsPending]);
  // Losing a snapshot (the server dropped it) lifts both the TTL and the retry
  // cooldown so the next check rescans at once.
  const hasWorkspaceSnapshot = hasCompleteProviderWorkspaceSnapshot(selectedProviderStatus, gitCwd);
  const [hadWorkspaceSnapshot, setHadWorkspaceSnapshot] = useState(hasWorkspaceSnapshot);
  const [workspaceSnapshotLossCount, setWorkspaceSnapshotLossCount] = useState(0);
  if (hadWorkspaceSnapshot !== hasWorkspaceSnapshot) {
    setHadWorkspaceSnapshot(hasWorkspaceSnapshot);
    if (!hasWorkspaceSnapshot) {
      setWorkspaceSnapshotLossCount((count) => count + 1);
      setWorkspaceRefreshRetry(null);
    }
  }
  const lastWorkspaceSnapshotLossRef = useRef(workspaceSnapshotLossCount);
  const refreshWorkspaceSnapshotIfStale = (
    now: number,
    key: string | null,
    retry: { key: string; notBefore: number } | null,
    snapshotLossCount: number,
  ) => {
    if (lastWorkspaceSnapshotLossRef.current !== snapshotLossCount) {
      lastWorkspaceSnapshotLossRef.current = snapshotLossCount;
      workspaceRefreshKeyRef.current = null;
    }
    if (key === null || !gitCwd || !selectedProviderEntry) return;
    const lastRequest = workspaceRefreshKeyRef.current;
    if (
      lastRequest?.key === key &&
      now - lastRequest.requestedAt < PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS
    )
      return;
    // A pending retry needs no clearing here: its cooldown lapses long before the TTL.
    if (hasCurrentProviderWorkspaceSnapshot(selectedProviderStatus, gitCwd, now)) return;
    if (retry?.key === key && now < retry.notBefore) return;
    const request = { key, requestedAt: now };
    workspaceRefreshKeyRef.current = request;
    const retryLater = () => {
      if (workspaceRefreshKeyRef.current !== request) return;
      workspaceRefreshKeyRef.current = null;
      setWorkspaceRefreshRetry({
        key,
        notBefore: Date.now() + WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS,
      });
    };
    void refreshProviders({
      environmentId,
      input: { instanceId: selectedProviderEntry.instanceId, cwd: gitCwd },
    }).then((result) => {
      const refreshedSnapshot =
        result._tag === "Success" &&
        hasCompleteProviderWorkspaceSnapshot(
          result.value.providers.find(
            (provider) => provider.instanceId === selectedProviderEntry.instanceId,
          ),
          gitCwd,
        );
      if (!refreshedSnapshot) retryLater();
    }, retryLater);
  };
  const refreshWorkspaceSnapshotOnChange = useEffectEvent(refreshWorkspaceSnapshotIfStale);
  useEffect(() => {
    refreshWorkspaceSnapshotOnChange(
      Date.now(),
      workspaceRefreshScopeKey,
      workspaceRefreshRetry,
      workspaceSnapshotLossCount,
    );
  }, [workspaceRefreshScopeKey, workspaceRefreshRetry, workspaceSnapshotLossCount]);
  return useStableCallback(() =>
    refreshWorkspaceSnapshotIfStale(
      Date.now(),
      workspaceRefreshScopeKey,
      workspaceRefreshRetry,
      workspaceSnapshotLossCount,
    ),
  );
}
