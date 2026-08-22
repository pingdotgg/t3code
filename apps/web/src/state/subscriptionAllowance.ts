import { useAtomCommand } from "../state/use-atom-command";
import { useAtomValue } from "@effect/atom-react";
import {
  createSubscriptionAllowanceRefreshTracker,
  isSubscriptionAllowanceCompatibilityCause,
  reconcileSubscriptionAllowances,
  type EnvironmentSubscriptionAllowanceStatus,
  type SubscriptionAllowanceProjection,
  type SubscriptionAllowanceSource,
} from "@t3tools/client-runtime/state/subscription-allowance";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo, useState } from "react";

import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

const subscriptionAllowanceByEnvironmentAtom = Atom.make(
  (get): readonly EnvironmentSubscriptionAllowanceStatus[] => {
    const presentations = get(environmentPresentations.presentationsAtom);
    const statuses: EnvironmentSubscriptionAllowanceStatus[] = [];

    for (const [environmentId, presentation] of presentations) {
      const result = get(serverEnvironment.subscriptionAllowance({ environmentId, input: {} }));
      const connectionPhase = presentation.connection.phase;
      const isConnected = connectionPhase === "connected";
      const compatibility =
        isConnected &&
        result._tag === "Failure" &&
        isSubscriptionAllowanceCompatibilityCause(result.cause);
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        connectionPhase,
        isPending: isConnected && result.waiting,
        compatibility,
        error:
          isConnected && result._tag === "Failure" && !compatibility
            ? "This environment could not report subscription usage."
            : null,
        snapshot: compatibility ? null : Option.getOrNull(AsyncResult.value(result)),
      });
    }

    return statuses;
  },
).pipe(Atom.withLabel("web-usage:subscription-allowance"));

export interface SubscriptionAllowanceView extends SubscriptionAllowanceProjection {
  readonly isRefreshing: boolean;
  readonly refresh: () => void;
}

export function useSubscriptionAllowance(): SubscriptionAllowanceView {
  const environments = useAtomValue(subscriptionAllowanceByEnvironmentAtom);
  const projection = useMemo(() => reconcileSubscriptionAllowances(environments), [environments]);
  const refreshAllowance = useAtomCommand(serverEnvironment.refreshSubscriptionAllowance, {
    reportFailure: false,
  });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [trackRefresh] = useState(() => createSubscriptionAllowanceRefreshTracker(setIsRefreshing));

  const refresh = useCallback(() => {
    void trackRefresh(
      projection.refreshEnvironmentIds.map((environmentId) =>
        refreshAllowance({
          environmentId,
          input: {},
        }),
      ),
    );
  }, [projection.refreshEnvironmentIds, refreshAllowance, trackRefresh]);

  return {
    ...projection,
    isRefreshing,
    refresh,
  };
}

export type { EnvironmentSubscriptionAllowanceStatus, SubscriptionAllowanceSource };
