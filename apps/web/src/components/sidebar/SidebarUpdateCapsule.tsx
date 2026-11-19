import { useAtomValue } from "@effect/atom-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { type ReactNode, useSyncExternalStore } from "react";

import type { MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentUpdateStatesAtom } from "~/state/server";
import { useServerUpdate } from "../ServerUpdateAction";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  describeUpdateCapsule,
  formatUpdateElapsed,
  RUN_STATUS_LABELS,
  resolveUpdateRunMachineStatus,
  type UpdateEverythingRun,
  type UpdateRunLocalState,
  type UpdateRunMachineView,
} from "./updateEverything.logic";
import {
  dismissSettledUpdateRunMachines,
  postponeUpdateRestart,
  retryFailedUpdateRunServers,
} from "./updateEverythingRun";

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

function localStatusLabel(
  run: UpdateEverythingRun,
  local: UpdateRunLocalState,
  now: number,
  resolve: MessageResolver,
) {
  if (run.phase === "countdown" && run.restartAt !== null) {
    return resolve(
      msg("restarts in {seconds}s", {
        seconds: Math.max(0, Math.ceil((run.restartAt - now) / 1000)),
      }),
    );
  }
  if (run.phase === "installing") return resolve(msg("restarting"));
  if (local?.status === "downloading") {
    return local.percent === null
      ? resolve(msg("downloading"))
      : resolve(msg("downloading {percent}%", { percent: Math.floor(local.percent) }));
  }
  return resolve(msg("restarts after the servers"));
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
  const hasActiveMachine = machines.some(
    ({ status }) => status !== "done" && status !== "failed" && status !== "waiting",
  );
  const now = useNow(run.phase === "countdown" ? 1_000 : hasActiveMachine ? 30_000 : null);
  const gt = useGT();
  const m = useMessages();
  const view = describeUpdateCapsule(run, machines, local, now, m);
  const updateServer = useServerUpdate();
  const failed = machines.some(({ status }) => status === "failed");
  const settled = !hasActiveMachine && run.localVersion === null;
  const restartSeconds =
    run.phase === "countdown" && run.restartAt !== null
      ? Math.max(0, Math.ceil((run.restartAt - now) / 1000))
      : null;

  const actionLabel =
    view.action === "later" ? gt("Later") : view.action === "retry" ? gt("Retry") : gt("Dismiss");
  const runAction = () => {
    if (view.action === "later") postponeUpdateRestart();
    else if (view.action === "retry") retryFailedUpdateRunServers(updateServer);
    else dismissSettledUpdateRunMachines();
  };

  return (
    <Popover>
      <div
        className={cn(
          "relative ml-auto flex h-8 w-8 shrink-0 items-center rounded-full bg-sidebar-control-surface text-sidebar-foreground @min-[12rem]/sidebar-update:w-full",
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
        <span className="pointer-events-none relative hidden min-w-0 flex-1 truncate pl-3 text-xs @min-[12rem]/sidebar-update:block">
          <span className={cn(view.tone === "failed" && "text-destructive")}>{view.label}</span>
          {view.slow ? (
            <span className="text-warning tabular-nums"> {view.slow.elapsed}</span>
          ) : null}
        </span>
        {view.action !== null ? (
          <button
            type="button"
            className="relative hidden shrink-0 cursor-pointer pr-3 pl-1.5 text-xs underline decoration-muted-foreground/60 underline-offset-3 hover:decoration-current @min-[12rem]/sidebar-update:block"
            onClick={runAction}
          >
            {actionLabel}
          </button>
        ) : null}
        <span
          className={cn(
            "pointer-events-none relative grid size-8 shrink-0 place-items-center",
            view.action !== null && "@min-[12rem]/sidebar-update:hidden",
            restartSeconds !== null &&
              "rounded-full text-xs font-medium tabular-nums ring-1 ring-current/22 ring-inset",
          )}
        >
          {restartSeconds !== null ? m(msg("{seconds}s", { seconds: restartSeconds })) : icon}
        </span>
      </div>
      <PopoverPopup side="top" align="end" padding="compact" width="sm">
        <div className="flex flex-col gap-1 text-xs">
          {run.localVersion !== null ? (
            <div className="flex items-center justify-between gap-3">
              <span>
                <T>This app</T>
              </span>
              <span className="text-muted-foreground tabular-nums">
                {localStatusLabel(run, local, now, m)}
              </span>
            </div>
          ) : onRestart ? (
            <div className="flex items-center justify-between gap-3">
              <span>
                <T>This app</T>
              </span>
              <Button size="xs" variant="outline" onClick={() => void onRestart()}>
                <T>Restart to update</T>
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
                  {m(RUN_STATUS_LABELS[status])}
                  {status !== "done" && status !== "failed" && status !== "waiting"
                    ? ` ${formatUpdateElapsed(now - machine.startedAt, m)}`
                    : ""}
                </span>
              </div>
              {machine.failure !== null ? (
                <span className="break-words text-muted-foreground">{machine.failure}</span>
              ) : null}
            </div>
          ))}
          {view.action !== null ? (
            <div className="mt-1 flex justify-end gap-1">
              <Button size="xs" variant="outline" onClick={runAction}>
                {actionLabel}
              </Button>
              {settled && failed && view.action !== "dismiss" ? (
                <Button size="xs" variant="ghost" onClick={dismissSettledUpdateRunMachines}>
                  <T>Dismiss</T>
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
