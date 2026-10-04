import type { OrchestrationV2ThreadProjection, ProviderDriverKind } from "@t3tools/contracts";

/** Never substitute a local checkout for a remote or unresolved conversation. */
export function threadLocalWorkspace(input: {
  readonly driver: ProviderDriverKind | undefined;
  readonly providerThreads: OrchestrationV2ThreadProjection["providerThreads"];
  readonly activeProviderThreadId: OrchestrationV2ThreadProjection["thread"]["activeProviderThreadId"];
  readonly detailLoaded?: boolean;
  readonly threadDeleted?: boolean;
  readonly providerConfigLoaded?: boolean;
  readonly loadError?: string | null;
  readonly worktreePath: string | null;
  readonly workspaceRoot: string | null;
}) {
  const active = input.providerThreads.find((thread) => thread.id === input.activeProviderThreadId);
  const cloud =
    input.driver === "kilo-cloud" ||
    active?.driver === "kilo-cloud" ||
    !!active?.nativeMetadata?.cloudExecution;
  const resolved = input.activeProviderThreadId === null || active !== undefined;
  const local =
    resolved &&
    input.driver !== undefined &&
    input.detailLoaded !== false &&
    input.providerConfigLoaded !== false &&
    !!(input.worktreePath ?? input.workspaceRoot);
  const state = cloud
    ? "cloud"
    : input.threadDeleted
      ? "unavailable"
      : local
        ? "local"
        : input.loadError
          ? "error"
          : input.detailLoaded === false || input.providerConfigLoaded === false
            ? "loading"
            : !resolved || input.driver === undefined
              ? input.providerConfigLoaded === true && input.detailLoaded === true
                ? "unavailable"
                : "loading"
              : !(input.worktreePath ?? input.workspaceRoot)
                ? "unavailable"
                : "local";
  const enabled = state === "local";
  return {
    localWorkspaceState: state,
    localWorkspaceEnabled: enabled,
    selectedThreadWorktreePath: enabled ? input.worktreePath : null,
    selectedThreadCwd: enabled ? (input.worktreePath ?? input.workspaceRoot) : null,
    selectedThreadGitRootCwd: enabled ? input.workspaceRoot : null,
  };
}
