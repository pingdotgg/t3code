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
  hideHandedOffUpdateRun,
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

function restartSecondsLeft(run: UpdateEverythingRun, now: number): number | null {
  return run.phase === "countdown" && run.restartAt !== null
    ? Math.max(0, Math.ceil((run.restartAt - now) / 1000))
    : null;
}

function localStatusLabel(
  run: UpdateEverythingRun,
  local: UpdateRunLocalState,
  now: number,
  resolve: MessageResolver,
) {
  const seconds = restartSecondsLeft(run, now);
  if (seconds !== null) return resolve(msg("restarts in {seconds}s", { seconds }));
  if (run.phase === "installing") return resolve(msg("restarting"));
  if (local?.status === "downloading") {
    return local.percent === null
      ? resolve(msg("downloading"))
      : resolve(msg("downloading {percent}%", { percent: Math.floor(local.percent) }));
  }
  return resolve(msg("restarts after the servers"));
}

interface UpdateRunProps {
  readonly run: UpdateEverythingRun;
  readonly local: UpdateRunLocalState;
  readonly onRestart?: (() => Promise<void>) | undefined;
}

function useUpdateRun(run: UpdateEverythingRun, local: UpdateRunLocalState) {
  const machines = useUpdateRunMachineViews(run);
  const hasActiveMachine = machines.some(
    ({ status }) => status !== "done" && status !== "failed" && status !== "waiting",
  );
  const now = useNow(run.phase === "countdown" ? 1_000 : hasActiveMachine ? 30_000 : null);
  const m = useMessages();
  const view = describeUpdateCapsule(run, machines, local, now, m);
  const updateServer = useServerUpdate();
  const runAction = () => {
    if (view.action === "later") postponeUpdateRestart();
    else if (view.action === "retry") retryFailedUpdateRunServers(updateServer);
    else dismissSettledUpdateRunMachines();
  };
  return {
    machines,
    now,
    view,
    runAction,
    failed: machines.some(({ status }) => status === "failed"),
    settled: !hasActiveMachine && run.localVersion === null,
    restartSeconds: restartSecondsLeft(run, now),
    // After a relaunch the run only waits on handed-off servers, which can take half an hour.
    waitsOnHandoff:
      run.localVersion === null &&
      run.machines.some(({ result }) => result === null) &&
      run.machines.every(
        ({ result, handedOffVersion }) => result !== null || handedOffVersion !== null,
      ),
    label: view.slow ? `${view.label} ${view.slow.status} ${view.slow.elapsed}` : view.label,
  };
}

/** The update control where the capsule does not fit: its icon opens the run's details. */
export function UpdateRunButton({
  run,
  local,
  onRestart,
  icon,
  className,
  updateState,
}: UpdateRunProps & {
  readonly icon: ReactNode;
  readonly className: string;
  readonly updateState: string;
}) {
  const runView = useUpdateRun(run, local);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={runView.label}
            data-update-state={updateState}
            className={className}
          />
        }
      >
        {icon}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" padding="compact" width="sm">
        <UpdateRunDetails run={run} local={local} onRestart={onRestart} runView={runView} />
      </PopoverPopup>
    </Popover>
  );
}

export function SidebarUpdateCapsule({
  run,
  local,
  icon,
  onRestart,
}: UpdateRunProps & { readonly icon: ReactNode }) {
  const runView = useUpdateRun(run, local);
  const { view, runAction, restartSeconds } = runView;
  const m = useMessages();
  const gt = useGT();
  const actionLabel =
    view.action === "later" ? gt("Later") : view.action === "retry" ? gt("Retry") : gt("Dismiss");

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
              aria-label={runView.label}
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
        <UpdateRunDetails run={run} local={local} onRestart={onRestart} runView={runView} />
      </PopoverPopup>
    </Popover>
  );
}

function UpdateRunDetails({
  run,
  local,
  onRestart,
  runView: { machines, now, view, runAction, failed, settled, waitsOnHandoff },
}: UpdateRunProps & { readonly runView: ReturnType<typeof useUpdateRun> }) {
  const m = useMessages();
  return (
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
      {settled && failed ? (
        <div className="mt-1 flex justify-end gap-1">
          {view.action === "retry" ? (
            <Button size="xs" variant="outline" onClick={runAction}>
              <T>Retry</T>
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" onClick={dismissSettledUpdateRunMachines}>
            <T>Dismiss</T>
          </Button>
        </div>
      ) : view.action === "later" ? (
        <div className="mt-1 flex justify-end">
          <Button size="xs" variant="outline" onClick={runAction}>
            <T>Later</T>
          </Button>
        </div>
      ) : waitsOnHandoff ? (
        <div className="mt-1 flex justify-end">
          <Button size="xs" variant="ghost" onClick={hideHandedOffUpdateRun}>
            <T>Hide</T>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
