import { useAtomValue } from "@effect/atom-react";
import { type ReactNode, useSyncExternalStore } from "react";

import { cn } from "~/lib/utils";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentUpdateStatesAtom } from "~/state/server";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  describeUpdateCapsule,
  formatUpdateElapsed,
  RUN_STATUS_LABELS,
  resolveUpdateRunMachineStatus,
  type UpdateEverythingRun,
  type UpdateRunLocalState,
  type UpdateCapsuleView,
  type UpdatePlanPausedReason,
  type UpdateRunMachineStatus,
  type UpdateRunMachineView,
} from "./updateEverything.logic";
import {
  continueWithoutLocalApp,
  dismissSettledUpdateRunMachines,
  dismissUpdatePlan,
  postponeUpdateRestart,
  retryUpdatePlan,
} from "./updateEverythingRun";

type UpdateCapsuleAction = NonNullable<UpdateCapsuleView["action"]>;

const ACTION_LABELS: Record<UpdateCapsuleAction, string> = {
  later: "Later",
  retry: "Retry",
  dismiss: "Dismiss",
  restart: "Restart",
  "continue-without-app": "Skip app",
};

const PAUSED_LABELS: Record<UpdatePlanPausedReason, string> = {
  later: "waiting for restart",
  "download-failed": "download failed",
  "install-refused": "restart did not start",
  "wrong-version": "wrong version installed",
  "not-applied": "update did not apply",
  expired: "plan expired",
  storage: "plan not saved",
  unknown: "needs review",
};

const isTimed = (status: UpdateRunMachineStatus) =>
  status !== "done" &&
  status !== "failed" &&
  status !== "waiting" &&
  status !== "waiting-dependency";

function secondaryActions(run: UpdateEverythingRun): UpdateCapsuleAction[] {
  if (run.phase === "complete") return ["dismiss"];
  if (run.phase !== "paused") return [];
  switch (run.pausedReason) {
    case "download-failed":
      return ["continue-without-app", "dismiss"];
    case "wrong-version":
    case "not-applied":
      return ["retry", "dismiss"];
    default:
      return ["dismiss"];
  }
}

function useNow(intervalMs: number | null): number {
  const step = intervalMs ?? 60_000;
  const subscribe = (onChange: () => void) => {
    if (intervalMs === null) return () => {};
    const timer = setInterval(onChange, intervalMs);
    return () => clearInterval(timer);
  };
  return useSyncExternalStore(subscribe, () => Math.floor(Date.now() / step) * step);
}

function useUpdateRunMachineViews(run: UpdateEverythingRun): ReadonlyArray<UpdateRunMachineView> {
  const updateStates = useAtomValue(
    environmentUpdateStatesAtom(
      environmentIdsKey(run.machines.map(({ environmentId }) => environmentId)),
    ),
  );
  return run.machines.map((machine, index) => ({
    machine,
    status: resolveUpdateRunMachineStatus(machine, run.phase, updateStates[index]!),
  }));
}

function localStatusLabel(run: UpdateEverythingRun, local: UpdateRunLocalState, now: number) {
  if (run.phase === "countdown" && run.restartAt !== null) {
    return `restarts in ${Math.max(0, Math.ceil((run.restartAt - now) / 1000))}s`;
  }
  if (run.phase === "installing") return "restarting";
  if (run.phase === "paused") return PAUSED_LABELS[run.pausedReason ?? "unknown"];
  if (run.phase !== "local") return "updated";
  if (local?.status === "downloading") {
    return `downloading${local.percent === null ? "" : ` ${Math.floor(local.percent)}%`}`;
  }
  return "updates first";
}

export function SidebarUpdateCapsule({
  run,
  local,
  icon,
  onRestart,
}: {
  readonly run: UpdateEverythingRun;
  readonly local: UpdateRunLocalState;
  readonly icon: ReactNode;
  readonly onRestart?: () => Promise<void>;
}) {
  const machines = useUpdateRunMachineViews(run);
  const hasActiveMachine = machines.some(({ status }) => isTimed(status));
  const now = useNow(run.phase === "countdown" ? 1_000 : hasActiveMachine ? 30_000 : null);
  const view = describeUpdateCapsule(run, machines, local, now);
  const isPlan = run.phase === "paused" || run.phase === "complete";
  const actions = [
    ...(view.action === null ? [] : [view.action]),
    ...secondaryActions(run).filter((action) => action !== view.action),
  ];
  const runAction = (action: UpdateCapsuleAction) => {
    if (action === "later") postponeUpdateRestart();
    else if (action === "continue-without-app") void continueWithoutLocalApp();
    else if (action === "restart" || action === "retry") void retryUpdatePlan();
    else if (isPlan) void dismissUpdatePlan();
    else dismissSettledUpdateRunMachines();
  };

  return (
    <Popover>
      <div
        className={cn(
          "relative flex h-8 min-w-0 flex-1 items-center rounded-full bg-sidebar-control-surface text-sidebar-foreground",
          view.tone === "slow" && "ring-1 ring-warning/40 ring-inset",
          view.tone === "failed" && "ring-1 ring-destructive/40 ring-inset",
        )}
      >
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={
                view.slow ? `${view.label} ${view.slow.status} ${view.slow.elapsed}` : view.label
              }
              className="absolute inset-0 cursor-pointer rounded-full outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset"
            />
          }
        />
        <span className="pointer-events-none relative min-w-0 flex-1 truncate pl-3 text-xs">
          <span className={cn(view.tone === "failed" && "text-destructive")}>{view.label}</span>
          {view.slow ? (
            <span className="text-warning tabular-nums"> {view.slow.elapsed}</span>
          ) : null}
        </span>
        {view.action !== null ? (
          <button
            type="button"
            className="relative shrink-0 cursor-pointer pr-3 pl-1.5 text-xs underline decoration-muted-foreground/60 underline-offset-3 hover:decoration-current"
            onClick={() => runAction(view.action!)}
          >
            {ACTION_LABELS[view.action]}
          </button>
        ) : (
          <span className="pointer-events-none relative grid size-8 shrink-0 place-items-center">
            {icon}
          </span>
        )}
      </div>
      <PopoverPopup side="top" align="end" padding="compact" width="sm">
        <div className="flex flex-col gap-1 text-xs">
          {run.localVersion !== null ? (
            <div className="flex items-center justify-between gap-3">
              <span>This device</span>
              <span
                className={cn(
                  "shrink-0 tabular-nums",
                  run.phase === "paused" && run.pausedReason !== "later"
                    ? "text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {localStatusLabel(run, local, now)}
              </span>
            </div>
          ) : onRestart ? (
            <div className="flex items-center justify-between gap-3">
              <span>This app</span>
              <Button size="xs" variant="outline" onClick={() => void onRestart()}>
                Restart to update
              </Button>
            </div>
          ) : null}
          {machines.map(({ machine, status }) => (
            <div key={machine.environmentId} className="flex min-w-0 flex-col">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate">{machine.label}</span>
                <span
                  className={cn(
                    "shrink-0 tabular-nums",
                    status === "failed" ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {RUN_STATUS_LABELS[status]}
                  {isTimed(status) ? ` ${formatUpdateElapsed(now - machine.startedAt)}` : ""}
                </span>
              </div>
              {machine.failure !== null ? (
                <span className="break-words text-muted-foreground">{machine.failure}</span>
              ) : null}
            </div>
          ))}
          {actions.length > 0 && view.action !== "later" ? (
            <div className="mt-1 flex justify-end gap-1">
              {actions.map((action, index) => (
                <Button
                  key={action}
                  size="xs"
                  variant={index === 0 ? "outline" : "ghost"}
                  onClick={() => runAction(action)}
                >
                  {action === "continue-without-app"
                    ? "Continue without app update"
                    : ACTION_LABELS[action]}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
