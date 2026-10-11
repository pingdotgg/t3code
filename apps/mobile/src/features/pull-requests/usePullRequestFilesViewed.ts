import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PullRequestDetail } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { pullRequestReviewKey } from "./pullRequestReviewDrafts";

export function usePullRequestFilesViewed(params: PullRequestParams, pr: PullRequestDetail | null) {
  const target = pullRequestTarget(params);
  const scopeKey = pullRequestReviewKey(params);
  const supported = Boolean(pr?.capabilities.viewedFiles);
  const allowed = useAtomValue(
    composerPullRequests.setFilesViewed.permissionAtom(target.environmentId),
  );
  const query = useEnvironmentQuery(supported ? composerPullRequests.filesViewed(target) : null);
  const refresh = useAtomRefresh(composerPullRequests.filesViewed(target));
  const write = useAtomCommand(composerPullRequests.setFilesViewed, { reportFailure: false });
  const [state, setState] = useState<{
    key: string;
    overlay: Record<string, boolean>;
    error: string | null;
  }>({ key: scopeKey, overlay: {}, error: null });
  const overlay = state.key === scopeKey ? state.overlay : {};
  const error = state.key === scopeKey ? state.error : null;
  const setOverlay = useCallback(
    (overlay: Record<string, boolean>) =>
      setState((current) => ({
        key: scopeKey,
        overlay,
        error: current.key === scopeKey ? current.error : null,
      })),
    [scopeKey],
  );
  const setError = (error: string | null) =>
    setState((current) => ({
      key: scopeKey,
      error,
      overlay: current.key === scopeKey ? current.overlay : {},
    }));
  const versions = useRef(new Map<string, number>());
  const pressed = useRef<Record<string, boolean>>({});
  const reads = useRef(query.data);
  useEffect(() => {
    reads.current = query.data;
  }, [query.data]);
  const awaitingRead = useRef(new Map<string, typeof query.data>());
  const scope = useRef(scopeKey);
  useEffect(() => {
    scope.current = scopeKey;
    versions.current.clear();
    awaitingRead.current.clear();
    pressed.current = {};
  }, [scopeKey]);
  useEffect(() => {
    if (supported && pr?.headSha) refresh();
  }, [supported, pr?.headSha, refresh]);
  useEffect(() => {
    let changed = false;
    const next = { ...pressed.current };
    for (const [path, from] of awaitingRead.current) {
      if (from === query.data) continue;
      delete next[path];
      awaitingRead.current.delete(path);
      changed = true;
    }
    if (changed) {
      pressed.current = next;
      setOverlay(next);
    }
  }, [query.data, setOverlay]);
  const isViewed = (path: string) =>
    overlay[path] ??
    query.data?.files.some((file) => file.path === path && file.state === "viewed") ??
    false;
  const toggle = async (path: string) => {
    if (!supported || !allowed || !query.data) return;
    const viewed = !(
      pressed.current[path] ??
      query.data.files.some((file) => file.path === path && file.state === "viewed")
    );
    const version = (versions.current.get(path) ?? 0) + 1;
    versions.current.set(path, version);
    awaitingRead.current.delete(path);
    pressed.current = { ...pressed.current, [path]: viewed };
    setOverlay(pressed.current);
    setError(null);
    const response = await write({
      ...target,
      input: { ...target.input, files: [{ path, viewed }] },
    });
    if (scope.current !== scopeKey) return;
    if (response._tag === "Failure" && versions.current.get(path) === version) {
      const next = { ...pressed.current };
      delete next[path];
      pressed.current = next;
      setOverlay(next);
      const cause = squashAtomCommandFailure(response);
      setError(cause instanceof Error ? cause.message : "Could not update viewed files.");
    }
    if (response._tag === "Success" && versions.current.get(path) === version)
      awaitingRead.current.set(path, reads.current);
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
