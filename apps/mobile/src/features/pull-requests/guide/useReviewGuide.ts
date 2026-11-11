import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { usePullRequestConnected } from "../usePullRequestConnected";
import { composerPullRequests } from "../../../state/pull-requests";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { pullRequestTarget, type PullRequestParams } from "../usePullRequestDiff";

export function useReviewGuidesEnabled(params: PullRequestParams) {
  const settings = useAtomValue(
    serverEnvironment.settingsValueAtom(pullRequestTarget(params).environmentId),
  );
  return settings?.reviewGuidesEnabled === true;
}

export function useReviewGuide(params: PullRequestParams, visible = true) {
  const target = pullRequestTarget(params);
  const enabled = useReviewGuidesEnabled(params);
  const query = useEnvironmentQuery(enabled ? composerPullRequests.reviewGuide(target) : null);
  const connected = usePullRequestConnected(target.environmentId);
  const permitted = useAtomValue(
    composerPullRequests.generateReviewGuide.permissionAtom(target.environmentId),
  );
  const canWrite = connected && permitted;
  const generate = useAtomCommand(composerPullRequests.generateReviewGuide, {
    reportFailure: false,
  });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const running = starting || query.data?.run?._tag === "Running";
  const refresh = query.refresh;
  useFocusEffect(() => {
    if (!enabled || !visible) return;
    refresh();
    if (!running) return;
    const timer = setInterval(refresh, 5_000);
    return () => clearInterval(timer);
  });
  const write = async () => {
    if (!enabled || !canWrite || running || pending.current) return;
    pending.current = true;
    setStarting(true);
    setError(null);
    const result = await generate(target);
    pending.current = false;
    setStarting(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not start the review guide.");
    }
  };
  return { ...query, enabled, canWrite, running, write, startError: error };
}
