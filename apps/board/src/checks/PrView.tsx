import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useContext, useState } from "react";

import type { PrLive } from "../domain/readiness";
import { markChecksPainted } from "../browser/panel";
import { NO_ACTIVITY, NO_DETAIL, pullRequestEnvironment } from "../state/prStatus";
import { CheckGroup } from "./CheckGroup";
import { PrAction } from "./PrAction";
import { PrComments } from "./PrComments";
import { PrHeader } from "./PrHeader";

/** One pull request open in the tab: its header and action, its checks, and its comments. */
export function PrView({
  environmentId,
  reference,
  live,
  now,
  active,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  live: PrLive | null;
  now: number;
  active: boolean;
}) {
  const registry = useContext(RegistryContext);
  const detailAtom = pullRequestEnvironment.detail({ environmentId, input: reference });
  const activityAtom = pullRequestEnvironment.activity({ environmentId, input: reference });
  const checksAtom = pullRequestEnvironment.checks({ environmentId, input: reference });
  // The header, rows and comments are read and drawn from the tab's first showing, so a board whose tab stays closed never pays for them.
  const [opened, setOpened] = useState(active);
  if (active && !opened) setOpened(true);
  const detailResult = useAtomValue(opened ? detailAtom : NO_DETAIL);
  const detail = AsyncResult.getOrElse(detailResult, () => null);
  const activity = AsyncResult.getOrElse(
    useAtomValue(opened ? activityAtom : NO_ACTIVITY),
    () => null,
  );
  const answered = AsyncResult.getOrElse(useAtomValue(checksAtom), () => null);
  const [refreshing, setRefreshing] = useState(false);

  // The rows are what the user waits on, so the paint waits for the checks read and for the list built from it, and not for the header or the comments.
  const painted =
    active &&
    answered !== null &&
    live !== null &&
    (answered.checks.length === 0 || live.checks.length > 0);
  const mark = useCallback(
    (element: HTMLElement | null) => {
      if (element === null || !painted) return;
      requestAnimationFrame(() => markChecksPainted());
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
    <div data-testid="checks-panel" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
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
          <div ref={mark}>
            <CheckGroup live={live} now={now} />
          </div>
        ))}
      {opened && <PrComments activity={activity} />}
    </div>
  );
}
