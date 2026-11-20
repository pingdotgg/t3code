import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useContext, useState } from "react";

import type { PrLive } from "../domain/readiness";
import { detailPollAtom, NO_POLL, pullRequestEnvironment } from "../state/prStatus";
import { CheckGroup } from "./CheckGroup";
import { PrAction } from "./PrAction";
import { PrComments } from "./PrComments";
import { PrHeader } from "./PrHeader";

/** One pull request open in the tab: its header and action, its checks, and its comments. */
export function PrView({
  environmentId,
  reference,
  pollKey,
  live,
  now,
  active,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  pollKey: string;
  live: PrLive | null;
  now: number;
  active: boolean;
}) {
  const registry = useContext(RegistryContext);
  const detailAtom = pullRequestEnvironment.detail({ environmentId, input: reference });
  const activityAtom = pullRequestEnvironment.activity({ environmentId, input: reference });
  const checksAtom = pullRequestEnvironment.checks({ environmentId, input: reference });
  const detailResult = useAtomValue(detailAtom);
  const detail = AsyncResult.getOrElse(detailResult, () => null);
  const activity = AsyncResult.getOrElse(useAtomValue(activityAtom), () => null);
  useAtomValue(active ? detailPollAtom(pollKey) : NO_POLL);
  const [refreshing, setRefreshing] = useState(false);
  // The rows and comments draw on the tab's first showing, so a board whose tab stays closed never pays for them.
  const [opened, setOpened] = useState(active);
  if (active && !opened) setOpened(true);

  // A ref callback runs after the commit that shows the rows, which is what the user waits on.
  const painted = active && opened && live !== null && detail !== null && activity !== null;
  const mark = useCallback(
    (element: HTMLElement | null) => {
      if (element !== null && painted) {
        requestAnimationFrame(() => performance.mark("board:checks-painted"));
      }
    },
    [painted],
  );

  const refresh = async () => {
    setRefreshing(true);
    await runAtomCommand(
      registry,
      pullRequestEnvironment.invalidate,
      { environmentId, input: { reference } },
      { reportFailure: false },
    );
    registry.refresh(detailAtom);
    registry.refresh(activityAtom);
    registry.refresh(checksAtom);
    setRefreshing(false);
  };
  return (
    <div
      ref={mark}
      data-testid="checks-panel"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <PrHeader
        reference={reference}
        detail={detail}
        refreshing={refreshing || detailResult.waiting}
        onRefresh={() => void refresh()}
      >
        {detail !== null && (
          <PrAction environmentId={environmentId} reference={reference} detail={detail} />
        )}
      </PrHeader>
      {detail === null && AsyncResult.isFailure(detailResult) && (
        <p role="alert" className="px-3 pt-2 text-[12px] text-red-300">
          Could not read this pull request.
        </p>
      )}
      {opened &&
        (live === null ? (
          <p className="border-y border-line px-3 py-2 text-[12px] text-faint">Loading checks</p>
        ) : (
          <CheckGroup live={live} now={now} />
        ))}
      {opened && <PrComments activity={activity} />}
    </div>
  );
}
