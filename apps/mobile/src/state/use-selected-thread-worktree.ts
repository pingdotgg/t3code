import * as Option from "effect/Option";
import { useMemo } from "react";

import { useSelectedThreadWorktreePath, useSelectedThreadDetailState } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { resolvePreferredThreadWorktreePath } from "../features/terminal/terminalLaunchContext";

import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { threadLocalWorkspace } from "./threadLocalWorkspace";

export function useSelectedThreadWorktree() {
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const detail = useSelectedThreadDetailState();
  const projection = Option.getOrNull(detail.data);
  const config = useEnvironmentQuery(
    selectedThread?.environmentId
      ? serverEnvironment.configProjection({
          environmentId: selectedThread.environmentId,
          input: {},
        })
      : null,
  );
  const detailWorktreePath = useSelectedThreadWorktreePath();

  const selectedThreadWorktreePath = useMemo(
    () =>
      resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: selectedThread?.worktreePath ?? null,
        threadDetailWorktreePath: detailWorktreePath,
      }),
    [detailWorktreePath, selectedThread?.worktreePath],
  );

  return threadLocalWorkspace({
    driver: config.data?.config.providers.find(
      (provider) => provider.instanceId === selectedThread?.providerInstanceId,
    )?.driver,
    detailLoaded: projection !== null,
    threadDeleted: detail.status === "deleted",
    providerConfigLoaded: config.data !== null,
    loadError:
      Option.getOrNull(detail.error) ??
      config.error ??
      selectedEnvironmentRuntime?.connectionError ??
      null,
    providerThreads: projection?.providerThreads ?? [],
    activeProviderThreadId: selectedThread?.activeProviderThreadId ?? null,
    worktreePath: selectedThreadWorktreePath,
    workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
  });
}
