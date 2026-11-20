import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useImperativeHandle, useRef, useState, type Ref } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { pullRequestPanelReference } from "./usePullRequestDetail";

const INTENT_DELAY_MS = 150;

interface PullRequestIntentTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

type IntentTargetSetter = (target: PullRequestIntentTarget | null) => void;

/**
 * Reads the detail and activity a row's panel will ask for once the pointer or focus rests on it,
 * so the click paints from them. Passing over rows asks the host nothing, and leaving a row stops
 * reading it. The reads live in the returned element, so a resting pointer re-renders that element
 * and not the list around it.
 */
export function usePullRequestIntentPrefetch(
  isListed: (target: PullRequestIntentTarget) => boolean,
) {
  const setTarget = useRef<IntentTargetSetter | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prefetch = useStableCallback((next: PullRequestIntentTarget | null) => {
    clearTimeout(timer.current);
    if (next === null) {
      setTarget.current?.(null);
      return;
    }
    timer.current = setTimeout(() => setTarget.current?.(next), INTENT_DELAY_MS);
  });
  return { prefetch, reads: <PullRequestIntentReads ref={setTarget} isListed={isListed} /> };
}

function PullRequestIntentReads({
  ref,
  isListed,
}: {
  ref: Ref<IntentTargetSetter>;
  isListed: (target: PullRequestIntentTarget) => boolean;
}) {
  const [target, setTarget] = useState<PullRequestIntentTarget | null>(null);
  useImperativeHandle(ref, () => setTarget, []);
  // A removed row fires no leave event.
  const listed = target !== null && isListed(target);
  if (target !== null && !listed) setTarget(null);
  const reference =
    target === null || !listed
      ? null
      : pullRequestPanelReference({ ...target, host: target.host.toLowerCase() });
  useEnvironmentQuery(
    target === null || reference === null
      ? null
      : pullRequestEnvironment.detail({
          environmentId: target.environmentId,
          input: { ...reference, allowStale: false },
        }),
  );
  useEnvironmentQuery(
    target === null || reference === null
      ? null
      : pullRequestEnvironment.activity({ environmentId: target.environmentId, input: reference }),
  );
  return null;
}
