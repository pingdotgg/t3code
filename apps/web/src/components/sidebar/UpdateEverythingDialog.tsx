import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { ChevronRightIcon } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "~/lib/utils";
import { environmentThreadShells } from "~/state/threads";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import type {
  RestartingMachine,
  UpdateItemKey,
  UpdatePickerDevice,
  UpdatePickerItem,
} from "./updateEverything.logic";

const isRunning = (status: string) =>
  status === "preparing" || status === "starting" || status === "running";

const runningThreadCountAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) =>
    environmentIds
      .split("\n")
      .filter((id) => id !== "")
      .reduce(
        (count, id) =>
          count +
          get(environmentThreadShells.environmentThreadsAtom(EnvironmentId.make(id))).filter(
            (thread) => isRunning(thread.status),
          ).length,
        0,
      ),
  ).pipe(Atom.withLabel(`update-everything-running-threads:${environmentIds}`)),
);

interface UpdateEverythingDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly devices: ReadonlyArray<UpdatePickerDevice>;
  readonly onConfirm: (selection: ReadonlySet<UpdateItemKey>, autoResume: boolean) => void;
}

export function UpdateEverythingDialog({
  open,
  onOpenChange,
  devices,
  onConfirm,
}: UpdateEverythingDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <UpdateEverythingForm devices={devices} onConfirm={onConfirm} />
      </DialogPopup>
    </Dialog>
  );
}

const isT3 = (item: UpdatePickerItem) => item.kind !== "provider";

function disabledReason(item: UpdatePickerItem, autoResume: boolean): string | null {
  if (item.disabledReason !== null || autoResume || !isT3(item)) return item.disabledReason;
  return item.canDisableAutoResume === true
    ? null
    : "Cannot turn off thread resume on this version";
}

function selectableItems(device: UpdatePickerDevice, autoResume: boolean): UpdatePickerItem[] {
  return device.unavailableReason === null
    ? device.items.filter((item) => disabledReason(item, autoResume) === null)
    : [];
}

function checkState(keys: ReadonlyArray<UpdateItemKey>, selected: ReadonlySet<UpdateItemKey>) {
  const count = keys.filter((key) => selected.has(key)).length;
  return {
    count,
    checked: count > 0 && count === keys.length,
    indeterminate: count > 0 && count < keys.length,
  };
}

function versionTrail({ fromVersion, toVersion }: UpdatePickerItem): string {
  const to = toVersion ?? "latest";
  return fromVersion === null ? to : `${fromVersion} → ${to}`;
}

function UpdateEverythingForm({
  devices,
  onConfirm,
}: Pick<UpdateEverythingDialogProps, "devices" | "onConfirm">) {
  const [selected, setSelected] = useState<ReadonlySet<UpdateItemKey>>(
    () =>
      new Set(devices.flatMap((device) => selectableItems(device, true)).map((item) => item.key)),
  );
  const [autoResume, setAutoResume] = useState(true);
  const setKeys = (keys: ReadonlyArray<UpdateItemKey>, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });

  const allItems = devices.flatMap((device) => selectableItems(device, autoResume));
  const t3Items = devices
    .flatMap((device) => selectableItems(device, true))
    .filter((item) => isT3(item) && selected.has(item.key));
  const chosen = allItems.filter((item) => selected.has(item.key));
  const all = checkState(
    allItems.map((item) => item.key),
    selected,
  );
  const restartsFirst = chosen.some((item) => item.kind === "app");

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen.length === 0) return;
        onConfirm(new Set(chosen.map((item) => item.key)), autoResume);
      }}
    >
      <DialogHeader>
        <DialogTitle>Choose updates</DialogTitle>
        <DialogDescription>
          {restartsFirst
            ? "This device updates and restarts first. Then other devices, then tools."
            : "Devices update first, then their tools."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {devices.map((device) => (
          <UpdateDeviceGroup
            key={device.id}
            device={device}
            defaultOpen={devices.length === 1}
            autoResume={autoResume}
            selected={selected}
            onToggle={setKeys}
          />
        ))}
        {t3Items.length > 0 ? (
          <ResumeOption
            restarts={chosen.flatMap((item) => item.restarts)}
            skipped={t3Items.filter((item) => disabledReason(item, autoResume) !== null).length}
            autoResume={autoResume}
            onAutoResumeChange={setAutoResume}
          />
        ) : null}
      </DialogPanel>
      <DialogFooter>
        {devices.length > 1 && allItems.length > 0 ? (
          <label className="flex cursor-pointer items-center gap-2.5 text-sm sm:mr-auto">
            <Checkbox
              checked={all.checked}
              indeterminate={all.indeterminate}
              onCheckedChange={(checked) =>
                setKeys(
                  allItems.map((item) => item.key),
                  checked === true,
                )
              }
            />
            <span>All</span>
            <span className="text-muted-foreground tabular-nums">
              {all.count} of {allItems.length}
            </span>
          </label>
        ) : null}
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={chosen.length === 0}>
          Update
        </Button>
      </DialogFooter>
    </form>
  );
}

function UpdateDeviceGroup({
  device,
  defaultOpen,
  autoResume,
  selected,
  onToggle,
}: {
  readonly device: UpdatePickerDevice;
  readonly defaultOpen: boolean;
  readonly autoResume: boolean;
  readonly selected: ReadonlySet<UpdateItemKey>;
  readonly onToggle: (keys: ReadonlyArray<UpdateItemKey>, checked: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const keys = selectableItems(device, autoResume).map((item) => item.key);
  const state = checkState(keys, selected);
  const name = <span className="min-w-0 flex-1 truncate font-medium">{device.label}</span>;

  return (
    <section
      aria-label={device.label}
      className="rounded-xl bg-zinc-25 p-1 text-sm ring-1 ring-black/5 dark:bg-white/[0.035] dark:ring-white/5"
    >
      {device.unavailableReason !== null ? (
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          {name}
          <span className="max-w-1/2 text-right text-muted-foreground text-xs">
            {device.unavailableReason}
          </span>
        </div>
      ) : (
        <Collapsible open={open} onOpenChange={setOpen}>
          <div className="flex items-center gap-1">
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted/40 has-disabled:cursor-default has-disabled:hover:bg-transparent">
              <Checkbox
                checked={state.checked}
                indeterminate={state.indeterminate}
                disabled={keys.length === 0}
                onCheckedChange={(checked) => onToggle(keys, checked === true)}
              />
              {name}
              {keys.length > 0 ? (
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {state.count} of {keys.length}
                </span>
              ) : null}
            </label>
            <CollapsibleTrigger
              aria-label={`${device.label} updates`}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <ChevronRightIcon aria-hidden className={cn("size-4", open && "rotate-90")} />
            </CollapsibleTrigger>
          </div>
          <CollapsiblePanel animate={false} render={<ul />}>
            {device.items.map((item) => (
              <UpdateItemRow
                key={item.key}
                item={item}
                disabledReason={disabledReason(item, autoResume)}
                checked={disabledReason(item, autoResume) === null && selected.has(item.key)}
                onCheckedChange={(checked) => onToggle([item.key], checked)}
              />
            ))}
          </CollapsiblePanel>
        </Collapsible>
      )}
    </section>
  );
}

function UpdateItemRow({
  item,
  disabledReason,
  checked,
  onCheckedChange,
}: {
  readonly item: UpdatePickerItem;
  readonly disabledReason: string | null;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const detailId = useId();
  const detail = disabledReason ?? item.note;

  return (
    <li>
      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg py-1.5 pr-2 pl-8 hover:bg-muted/40 has-disabled:cursor-default has-disabled:hover:bg-transparent">
        <span className="flex h-5 shrink-0 items-center">
          <Checkbox
            checked={checked}
            disabled={disabledReason !== null}
            onCheckedChange={(value) => onCheckedChange(value === true)}
            {...(detail !== null ? { "aria-describedby": detailId } : {})}
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="max-w-full truncate">{item.label}</span>
            {item.context !== null ? (
              <span className="min-w-0 max-w-full truncate text-muted-foreground text-xs">
                {item.context}
              </span>
            ) : null}
          </span>
          <span className="text-muted-foreground text-xs tabular-nums wrap-anywhere">
            {versionTrail(item)}
          </span>
          {detail !== null ? (
            <span id={detailId} className="text-muted-foreground text-xs wrap-anywhere">
              {detail}
            </span>
          ) : null}
        </span>
      </label>
    </li>
  );
}

function ResumeOption({
  restarts,
  skipped,
  autoResume,
  onAutoResumeChange,
}: {
  readonly restarts: ReadonlyArray<RestartingMachine>;
  readonly skipped: number;
  readonly autoResume: boolean;
  readonly onAutoResumeChange: (autoResume: boolean) => void;
}) {
  const detailId = useId();
  const running = useAtomValue(
    runningThreadCountAtom(
      [...new Set(restarts.map((machine) => machine.environmentId))].join("\n"),
    ),
  );

  return (
    <div className="flex flex-col gap-2 px-1 text-sm">
      {running > 0 ? (
        <p role="note">
          {running} running {running === 1 ? "thread" : "threads"} will be interrupted.
        </p>
      ) : null}
      <label className="flex cursor-pointer items-start gap-2.5">
        <span className="flex h-5 shrink-0 items-center">
          <Checkbox
            checked={autoResume}
            onCheckedChange={(checked) => onAutoResumeChange(checked === true)}
            aria-describedby={detailId}
          />
        </span>
        <span className="flex min-w-0 flex-col">
          <span>Resume interrupted threads</span>
          <span id={detailId} className="text-muted-foreground text-xs">
            {autoResume
              ? "Follows each device's thread continuation settings."
              : skipped > 0
                ? `Skips ${skipped} T3 Code ${skipped === 1 ? "update" : "updates"} that can't turn this off.`
                : "Threads stay stopped after this update."}
          </span>
        </span>
      </label>
    </div>
  );
}
