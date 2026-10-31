import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

const INTENT_DELAY_MS = 150;

interface PullRequestIntentTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

/**
 * Reads the detail a row's panel will ask for once the pointer or focus rests on it, so the
 * click paints from it. Passing over rows asks the host nothing, and leaving a row or the row
 * leaving the list stops reading it, so turn refreshes do not keep re-reading it.
 */
export function usePullRequestIntentPrefetch(
  isListed: (target: PullRequestIntentTarget) => boolean,
) {
  const [target, setTarget] = useState<PullRequestIntentTarget | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<PullRequestIntentTarget | null>(null);
  // A removed row fires no leave event, and coming back is not new intent.
  const listed = target !== null && isListed(target);
  if (target !== null && !listed) setTarget(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a removed row fires no leave event, so its pending intent timer is cancelled once the list commits without it
  useEffect(() => {
    if (pending.current === null || isListed(pending.current)) return;
    clearTimeout(timer.current);
    pending.current = null;
  });
  useEnvironmentQuery(
    target === null || !listed
      ? null
      : pullRequestEnvironment.detail({
          environmentId: target.environmentId,
          input: {
            projectId: target.projectId,
            host: target.host.toLowerCase(),
            repository: target.repository,
            number: target.number,
            allowStale: false,
          },
        }),
  );
  return useStableCallback((next: PullRequestIntentTarget | null) => {
    clearTimeout(timer.current);
    pending.current = next;
    if (next === null) {
      setTarget(null);
      return;
    }
    timer.current = setTimeout(() => {
      pending.current = null;
      setTarget(next);
    }, INTENT_DELAY_MS);
  });
}
