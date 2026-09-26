import { CheckIcon } from "lucide-react";
import {
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentUpdateGroups } from "./ProviderUpdateLaunchNotification.environments";
import {
  collectProviderUpdateOutcomeSnapshots,
  type EnvironmentUpdateGroup,
  firstRejectedProviderUpdateMessage,
  getProviderUpdateInitialToastView,
  getProviderUpdateProgressToastView,
  getProviderUpdateSidebarPillView,
  isTerminalProviderUpdatePhase,
  resolveEnvironmentUpdateRowStatus,
  type ProviderUpdateOutcome,
  type ProviderUpdateRowStatus,
  type ProviderUpdateRowStatusKind,
  type ProviderUpdateToastView,
} from "./ProviderUpdateLaunchNotification.logic";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

type ProviderUpdateCommandResult = AtomCommandResult<
  { readonly providers: ReadonlyArray<ServerProvider> },
  unknown
>;

/**
 * Map one targeted instance's update command result into the settled-outcome
 * shape the multi-environment reducers consume: a non-interrupted failure becomes a
 * rejection carrying its message; a success carries the post-update snapshot of
 * the targeted instance (null when the backend did not report it).
 */
function toProviderUpdateOutcome(input: {
  readonly environmentId: EnvironmentId;
  readonly isPrimary: boolean;
  readonly target: {
    readonly driver: ServerProvider["driver"];
    readonly instanceId: ServerProvider["instanceId"];
  };
  readonly result: ProviderUpdateCommandResult;
}): PromiseSettledResult<ProviderUpdateOutcome> {
  if (input.result._tag === "Failure") {
    if (isAtomCommandInterrupted(input.result)) {
      // An interrupted dispatch (e.g. superseded) is neither a success nor a
      // hard failure — surface it as a non-contributing, non-rejecting outcome.
      return {
        status: "fulfilled",
        value: {
          environmentId: input.environmentId,
          isPrimary: input.isPrimary,
          driver: input.target.driver,
          instanceId: input.target.instanceId,
          provider: null,
        },
      };
    }
    const error = squashAtomCommandFailure(input.result);
    return {
      status: "rejected",
      reason: error instanceof Error ? error : new Error("Provider update failed."),
    };
  }

  const provider =
    input.result.value.providers.find(
      (candidate) => candidate.instanceId === input.target.instanceId,
    ) ?? null;
  return {
    status: "fulfilled",
    value: {
      environmentId: input.environmentId,
      isPrimary: input.isPrimary,
      driver: input.target.driver,
      instanceId: input.target.instanceId,
      provider,
    },
  };
}

// Transport-hang safety net. The dispatch's `finally` clears the spinner and the
// in-flight guard on completion, so this only matters if a request never resolves
// at all (e.g. the socket drops mid-flight without surfacing an error). Keep it
// well beyond the server's own update timeout (5 min) so a legitimately slow
// update (npm installs routinely run tens of seconds) is never cut off and left
// showing a dead, unresponsive Update button.
const PENDING_EXPIRY_MS = 6 * 60_000;

function rowToneClass(kind: ProviderUpdateRowStatusKind): string {
  switch (kind) {
    case "failed":
      return "text-destructive";
    case "unchanged":
      return "text-warning";
    case "success":
      return "text-success";
    default:
      return "text-muted-foreground";
  }
}

function EnvironmentUpdateRow({
  group,
  status,
  onUpdate,
  solo,
}: {
  readonly group: EnvironmentUpdateGroup;
  readonly status: ProviderUpdateRowStatus;
  readonly onUpdate: () => void;
  /** The only environment listed: read like the single-prompt body, with the footer action as the trigger. */
  readonly solo: boolean;
}) {
  if (solo) {
    const atRest = status.kind === "idle" || status.kind === "manual";
    return (
      <span className={cn("text-muted-foreground", !atRest && rowToneClass(status.kind))}>
        {atRest
          ? getProviderUpdateInitialToastView({
              updateProviders: [...group.candidates, ...group.manualCandidates],
              oneClickProviders: group.candidates,
            }).description
          : status.text}
      </span>
    );
  }

  let trailing: ReactNode;
  switch (status.kind) {
    case "loading":
      trailing = <Spinner size="md" tone="muted" />;
      break;
    case "success":
      trailing = <CheckIcon aria-hidden="true" className="size-4 text-success" />;
      break;
    case "failed":
    case "unchanged":
      trailing = (
        <Button size="xs" variant="outline" onClick={onUpdate}>
          Retry
        </Button>
      );
      break;
    case "manual":
      // The footer's Settings action is the way in; no per-row trigger.
      trailing = null;
      break;
    default:
      trailing = (
        <Button size="xs" variant="outline" onClick={onUpdate}>
          Update
        </Button>
      );
      break;
  }

  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <div className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-medium text-foreground">{group.label}</span>
          {group.isPrimary ? (
            // The primary's label is its OS, which another listed machine can share.
            <span className="shrink-0 text-xs text-muted-foreground">This machine</span>
          ) : null}
        </span>
        <span className={cn("truncate text-xs", rowToneClass(status.kind))}>{status.text}</span>
      </div>
      <div className="shrink-0">{trailing}</div>
    </div>
  );
}

/**
 * The launch popover body for multi-environment clients. Each environment gets
 * its own update trigger, and every command targets that environment's server.
 */
export function ProviderUpdateEnvironmentRows({
  onInteract,
  updateAllRef,
}: {
  /** Called the first time the user triggers an update, so the host can stop refreshing the prompt. */
  readonly onInteract?: () => void;
  /** Filled with a function that updates every environment still offering one, for the host's "Update all" action. */
  readonly updateAllRef?: MutableRefObject<(() => void) | null>;
}) {
  const { groups } = useEnvironmentUpdateGroups();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const groupByEnvironment = useMemo(
    () => new Map(groups.map((group) => [group.environmentId, group] as const)),
    [groups],
  );

  // Only surface results that land after this popover opened.
  const visibleAfterIsoRef = useRef<string>(new Date().toISOString());

  // Synchronous re-entry guard. setPendingEnvironments is an async state update,
  // and PENDING_EXPIRY_MS can clear the spinner while a request is still in
  // flight, so a rapid double-click (or a click after the expiry fires mid-
  // request) would otherwise dispatch a second full round of updates. A ref
  // updates synchronously, so we can bail before doing any work.
  const inFlightEnvironmentsRef = useRef<Set<EnvironmentId>>(new Set());

  // Monotonic per-environment request version. Bumped on each dispatch and
  // captured locally, so an attempt that was superseded -- e.g. one that already
  // tripped the expiry safety net and was retried -- detects it is no longer
  // current and skips every state write when it finally resolves, instead of
  // clobbering the newer attempt's spinner/result/error or its in-flight guard.
  const requestVersionRef = useRef<Map<EnvironmentId, number>>(new Map());

  const [pendingEnvironments, setPendingEnvironments] = useState<ReadonlySet<EnvironmentId>>(
    () => new Set(),
  );
  const [errorByEnvironment, setErrorByEnvironment] = useState<ReadonlyMap<EnvironmentId, string>>(
    () => new Map(),
  );
  const [resultByEnvironment, setResultByEnvironment] = useState<
    ReadonlyMap<EnvironmentId, ProviderUpdateToastView>
  >(() => new Map());

  const clearPending = useCallback((environmentId: EnvironmentId) => {
    setPendingEnvironments((previous) => {
      if (!previous.has(environmentId)) {
        return previous;
      }
      const next = new Set(previous);
      next.delete(environmentId);
      return next;
    });
  }, []);

  const handleUpdate = useCallback(
    async (environmentId: EnvironmentId) => {
      const group = groupByEnvironment.get(environmentId);
      if (!group || group.candidates.length === 0) {
        return;
      }
      if (inFlightEnvironmentsRef.current.has(environmentId)) {
        return;
      }
      inFlightEnvironmentsRef.current.add(environmentId);
      const requestVersion = (requestVersionRef.current.get(environmentId) ?? 0) + 1;
      requestVersionRef.current.set(environmentId, requestVersion);
      const isCurrentRequest = () =>
        requestVersionRef.current.get(environmentId) === requestVersion;
      onInteract?.();
      const providerCount = group.candidates.length;
      const targets = group.candidates.map((candidate) => ({
        driver: candidate.driver,
        instanceId: candidate.instanceId,
      }));

      setPendingEnvironments((previous) => new Set(previous).add(environmentId));
      setErrorByEnvironment((previous) => {
        if (!previous.has(environmentId)) {
          return previous;
        }
        const next = new Map(previous);
        next.delete(environmentId);
        return next;
      });
      setResultByEnvironment((previous) => {
        if (!previous.has(environmentId)) {
          return previous;
        }
        const next = new Map(previous);
        next.delete(environmentId);
        return next;
      });

      const expiry = setTimeout(() => {
        // A newer attempt may have superseded this one; if so, leave its state
        // untouched.
        if (!isCurrentRequest()) {
          return;
        }
        // The request is presumed dead (see PENDING_EXPIRY_MS). Clear the
        // spinner AND the in-flight guard together so the row never strands on a
        // dead Update button, and surface feedback so the timeout is visible
        // rather than silently reverting to idle.
        inFlightEnvironmentsRef.current.delete(environmentId);
        clearPending(environmentId);
        setErrorByEnvironment((previous) =>
          new Map(previous).set(environmentId, "Update timed out — try again."),
        );
      }, PENDING_EXPIRY_MS);
      try {
        // Dispatch each candidate's update to this environment's own backend and
        // normalize every settled outcome into the multi-environment reducer shape.
        const results = await Promise.all(
          targets.map(async (target): Promise<PromiseSettledResult<ProviderUpdateOutcome>> => {
            try {
              const result = await updateProvider({
                environmentId,
                input: { provider: target.driver, instanceId: target.instanceId },
              });
              return toProviderUpdateOutcome({
                environmentId,
                isPrimary: group.isPrimary,
                target,
                result,
              });
            } catch (error) {
              return {
                status: "rejected",
                reason: error instanceof Error ? error : new Error("Provider update failed."),
              };
            }
          }),
        );
        if (!isCurrentRequest()) {
          // A newer attempt superseded this one while it was in flight; leave
          // the newer attempt's state intact.
          return;
        }
        // The request resolved (not a transport hang), so clear any stale
        // timeout error the expiry may have set -- otherwise a late success
        // would be masked, since an error takes priority in the row status.
        setErrorByEnvironment((previous) => {
          if (!previous.has(environmentId)) {
            return previous;
          }
          const next = new Map(previous);
          next.delete(environmentId);
          return next;
        });
        if (results.length === 0) {
          setErrorByEnvironment((previous) =>
            new Map(previous).set(
              environmentId,
              "This environment isn’t connected — try again once it reconnects.",
            ),
          );
          return;
        }
        const rejectedMessage = firstRejectedProviderUpdateMessage(results);
        if (rejectedMessage) {
          setErrorByEnvironment((previous) =>
            new Map(previous).set(environmentId, rejectedMessage),
          );
          return;
        }
        const view = getProviderUpdateProgressToastView({
          providers: collectProviderUpdateOutcomeSnapshots(results),
          providerCount,
        });
        // Only persist a terminal outcome. A non-terminal ("running"/"initial")
        // view means this dispatch could not confirm completion — e.g. a snapshot
        // came back without its targeted instance (collectProviderUpdateOutcome-
        // Snapshots drops null providers), which happens when the command is
        // interrupted as a second backend connects and supersedes the in-flight
        // update. A stored view never re-polls, so persisting it would pin the
        // row's spinner forever once the pending flag expires. Drop it and let
        // the live per-environment provider state (pill) plus the pending expiry
        // drive the row, so it self-heals to whatever the backend actually did.
        if (isTerminalProviderUpdatePhase(view.phase)) {
          setResultByEnvironment((previous) => new Map(previous).set(environmentId, view));
        }
      } catch (error) {
        if (isCurrentRequest()) {
          setErrorByEnvironment((previous) =>
            new Map(previous).set(
              environmentId,
              error instanceof Error ? error.message : "Provider update failed.",
            ),
          );
        }
      } finally {
        clearTimeout(expiry);
        // Only the current attempt owns the shared spinner and in-flight guard;
        // a superseded attempt resolving late must not clear a newer one's.
        if (isCurrentRequest()) {
          clearPending(environmentId);
          inFlightEnvironmentsRef.current.delete(environmentId);
        }
      }
    },
    [clearPending, groupByEnvironment, onInteract, updateProvider],
  );

  // "Update all" goes through the same per-environment path as the row
  // buttons, so each environment keeps its own spinner, result, and guards.
  useEffect(() => {
    if (!updateAllRef) {
      return;
    }
    updateAllRef.current = () => {
      for (const group of groups) {
        if (group.candidates.length > 0) {
          void handleUpdate(group.environmentId);
        }
      }
    };
    return () => {
      updateAllRef.current = null;
    };
  }, [groups, handleUpdate, updateAllRef]);

  const rows = groups
    .map((group) => ({
      group,
      status: resolveEnvironmentUpdateRowStatus({
        group,
        error: errorByEnvironment.get(group.environmentId),
        result: resultByEnvironment.get(group.environmentId),
        // Derive the live pill from the candidates this row is actually
        // tracking, not every provider in the environment. Otherwise an
        // unrelated provider's recent success (or one candidate succeeding while
        // another was interrupted) makes the pill report success and hides the
        // Update action for candidates that are still outdated.
        pill: getProviderUpdateSidebarPillView(group.candidates, {
          visibleAfterIso: visibleAfterIsoRef.current,
        }),
        isPending: pendingEnvironments.has(group.environmentId),
      }),
    }))
    .filter(
      ({ group, status }) =>
        group.candidates.length > 0 || group.manualCandidates.length > 0 || status.kind !== "idle",
    );

  if (rows.length === 0) {
    return null;
  }

  // With one environment listed there is nothing to tell apart, so the body
  // reads like the single prompt. With several, the stacked toast body's
  // `pr-5` under the close button is extended across so the row buttons share
  // a right edge with the footer actions, and a divider closes the list.
  const solo = rows.length === 1;
  return (
    <div className={cn("mt-0.5 flex flex-col gap-1", !solo && "-mr-5 border-b border-border pb-2")}>
      {rows.map(({ group, status }) => (
        <EnvironmentUpdateRow
          key={group.environmentId}
          group={group}
          status={status}
          onUpdate={() => handleUpdate(group.environmentId)}
          solo={solo}
        />
      ))}
    </div>
  );
}
