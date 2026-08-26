/**
 * Fetching a report's evidence before the reader reaches it.
 *
 * A report's artefacts carry the things the card cannot draw without: the
 * agent's justification, the repository it chose, the reviewers it named.
 * Fetched on arrival, all three land after the card has already painted, and
 * the reader watches the verdict rewrite itself under the cursor.
 *
 * The query family holds a resolved value for its idle TTL, well past the
 * subscription that fetched it, so warming a report here is enough to make its
 * card paint from cache — no request, no late arrival, no reflow. Triage
 * refuses to deal a card whose artefacts have not landed; this is what keeps
 * that from being felt.
 */
import type { EnvironmentId, PostHogReport } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { postHogEnvironment } from "../../state/posthog";
import { useEnvironmentQuery } from "../../state/query";

type ReportId = PostHogReport["id"];

/**
 * Gap between one warm-up request and the next. Enough that the window does
 * not arrive at PostHog as a burst, short enough that a reader walking the
 * queue at a normal pace never catches up with it.
 */
const WARM_STAGGER_MS = 250;

function WarmReportArtefacts({
  environmentId,
  reportId,
  delayMs,
}: {
  readonly environmentId: EnvironmentId;
  readonly reportId: ReportId;
  readonly delayMs: number;
}) {
  const armed = useSettled(reportId, delayMs);
  useEnvironmentQuery(
    armed === null ? null : postHogEnvironment.artefacts({ environmentId, input: { reportId } }),
  );
  return null;
}

/**
 * Holds a subscription open for each report so its artefacts are in hand
 * before the reader asks for them. Mount it with the window you expect them to
 * reach next, not the whole queue: every id here is one request out to
 * PostHog.
 *
 * Fetched in order rather than all at once. The nearest report is the one the
 * reader is about to reach, and a reader moving faster than the trickle
 * unmounts the far end before it ever asks for it.
 */
export function ReportArtefactWarmup({
  environmentId,
  reportIds,
}: {
  readonly environmentId: EnvironmentId;
  readonly reportIds: ReadonlyArray<ReportId>;
}) {
  return (
    <>
      {reportIds.map((reportId, position) => (
        <WarmReportArtefacts
          key={reportId}
          environmentId={environmentId}
          reportId={reportId}
          delayMs={position * WARM_STAGGER_MS}
        />
      ))}
    </>
  );
}

/**
 * Who the environment's PostHog key belongs to, in the one identity PostHog
 * keys reviewer rows by. The same answer for every report and every card, so
 * whichever surface is on screen holds the subscription and everything else
 * reads it from cache.
 */
export function usePostHogViewerLogin(environmentId: EnvironmentId): string | null {
  const query = useEnvironmentQuery(postHogEnvironment.currentUser({ environmentId, input: {} }));
  return query.data?.github_login?.toLowerCase() ?? null;
}

/** True once `value` has held steady for `delayMs`. Never true for `null`. */
export function useSettled<T>(value: T | null, delayMs: number): T | null {
  const [settled, setSettled] = useState<T | null>(null);
  useEffect(() => {
    if (value === null) {
      setSettled(null);
      return;
    }
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);
  return settled;
}
