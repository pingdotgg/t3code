import { usePullRequestConnected } from "./usePullRequestConnected";
import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PullRequestDetail } from "@t3tools/contracts";
import { use, useState } from "react";
import {
  composerPullRequests,
  filesViewedReadsFamily,
  filesViewedReadsKey,
} from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { pullRequestReviewKey } from "./pullRequestReviewDrafts";
import { viewedOverlay, type ViewedState } from "./pullRequestFilesViewed";

export function usePullRequestFilesViewed(params: PullRequestParams, pr: PullRequestDetail | null) {
  const registry = use(RegistryContext);
  const target = pullRequestTarget(params);
  const scopeKey = pullRequestReviewKey(params);
  const supported = Boolean(pr?.capabilities.viewedFiles);
  const permission = useAtomValue(
    composerPullRequests.setFilesViewed.permissionAtom(target.environmentId),
  );
  const connected = usePullRequestConnected(params.environmentId);
  const allowed = connected && permission;
  const query = useEnvironmentQuery(supported ? composerPullRequests.filesViewed(target) : null);
  const refresh = useAtomRefresh(composerPullRequests.filesViewed(target));
  const readsAtom = filesViewedReadsFamily(filesViewedReadsKey(target));
  const reads = useAtomValue(readsAtom);
  const write = useAtomCommand(composerPullRequests.setFilesViewed, { reportFailure: false });
  const [state, setState] = useState<ViewedState>({ key: scopeKey, presses: {}, error: null });
  const presses = state.key === scopeKey ? state.presses : {};
  const error = state.key === scopeKey ? state.error : null;
  const overlay = viewedOverlay(presses, reads);
  const update = (change: (current: ViewedState) => ViewedState) =>
    setState((current) =>
      change(current.key === scopeKey ? current : { key: scopeKey, presses: {}, error: null }),
    );
  const serverViewed = (path: string) =>
    query.data?.files.some((file) => file.path === path && file.state === "viewed") ?? false;
  const isViewed = (path: string) => overlay[path] ?? serverViewed(path);
  const toggle = async (path: string) => {
    if (!supported || !allowed || !query.data) return;
    const viewed = !isViewed(path);
    const version = (presses[path]?.version ?? 0) + 1;
    update((current) => ({
      ...current,
      error: null,
      presses: { ...current.presses, [path]: { viewed, version, awaitingReadAfter: undefined } },
    }));
    const response = await write({
      ...target,
      input: { ...target.input, files: [{ path, viewed }] },
    });
    // A read completed by the time the write lands may predate it; the next one carries it.
    const readsAtWrite = registry.get(readsAtom);
    setState((current) => {
      if (current.key !== scopeKey || current.presses[path]?.version !== version) return current;
      if (response._tag === "Success")
        return {
          ...current,
          presses: {
            ...current.presses,
            [path]: { viewed, version, awaitingReadAfter: readsAtWrite },
          },
        };
      const rest = { ...current.presses };
      delete rest[path];
      const cause = squashAtomCommandFailure(response);
      return {
        ...current,
        presses: rest,
        error: cause instanceof Error ? cause.message : "Could not update viewed files.",
      };
    });
    refresh();
  };
  return {
    supported,
    canToggle: supported && allowed && Boolean(query.data),
    isViewed,
    toggle,
    error: error ?? query.error,
    truncated: query.data?.truncated,
  };
}
