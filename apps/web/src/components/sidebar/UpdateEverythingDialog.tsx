import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { ChevronRightIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { Fragment, type RefObject, useRef, useState } from "react";

import { environmentThreadShells } from "~/state/threads";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Checkbox } from "../ui/checkbox";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ScrollArea } from "../ui/scroll-area";
import type {
  RestartingMachine,
  UpdateEverythingRow,
  UpdateMachineSelection,
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
  readonly version: string | null;
  readonly providerCount: number;
  readonly rows: ReadonlyArray<UpdateEverythingRow>;
  readonly restarts: ReadonlyArray<RestartingMachine>;
  readonly onConfirm: (selection?: UpdateMachineSelection) => void;
  readonly selectable?: boolean;
  /** Overrides the "Update N machines?" title, for an update-track switch. */
  readonly title?: string;
  readonly confirmLabel?: string;
  readonly notes?: ReadonlyArray<string>;
  /** Shown in place of running-thread counts; disables the confirm button. */
  readonly disabledReason?: string | null;
  /** The confirmed work is starting; it cannot be cancelled from here. */
  readonly busy?: boolean;
  /** Machines are still looking for provider updates, so more rows can appear. */
  readonly checking?: boolean;
}

type UpdateEverythingDialogContentProps = Omit<
  UpdateEverythingDialogProps,
  "open" | "onOpenChange"
> & {
  readonly cancelRef: RefObject<HTMLButtonElement | null>;
};

export function UpdateEverythingDialog({
  open,
  onOpenChange,
  ...content
}: UpdateEverythingDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* Refocusing the trigger after a pointer close shows its focus ring and opens its tooltip. */}
      <AlertDialogPopup
        className="sm:max-w-xl"
        initialFocus={cancelRef}
        finalFocus={(closeType) => closeType === "keyboard"}
      >
        <UpdateEverythingDialogContent {...content} cancelRef={cancelRef} />
      </AlertDialogPopup>
    </AlertDialog>
  );
}

const APP_LABELS = {
  "this-app": msg("This app"),
  server: msg("Server"),
  "desktop-app": msg("Desktop app"),
} as const;

function UpdateEverythingDialogContent({
  version,
  providerCount,
  rows,
  restarts: allRestarts,
  onConfirm,
  selectable = false,
  cancelRef,
  title,
  confirmLabel,
  notes = [],
  disabledReason = null,
  busy = false,
  checking = false,
}: UpdateEverythingDialogContentProps) {
  const gt = useGT();
  const m = useMessages();
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const rowKey = (row: UpdateEverythingRow) =>
    row.hostedByThisApp || row.app === "this-app" ? "this-app" : (row.environmentId ?? "this-app");
  const updating = rows.filter((row) => row.app !== null || row.providers.length > 0);
  const selected = updating.filter((row) => !selectable || !excluded.has(rowKey(row)));
  const selectedIds = new Set(
    selected.flatMap((row) => (row.environmentId === null ? [] : [row.environmentId])),
  );
  const restarts = allRestarts.filter(
    (machine) => !selectable || selectedIds.has(machine.environmentId),
  );
  const selectedProviderCount = selectable
    ? selected.reduce((count, row) => count + row.providers.length, 0)
    : providerCount;
  const selectedVersion = selected.some((row) => row.app !== null) ? version : null;
  const stopped = useAtomValue(
    runningThreadCountAtom(
      restarts
        .filter((machine) => !machine.continuesThreads)
        .map((machine) => machine.environmentId)
        .join("\n"),
    ),
  );
  const continuing = useAtomValue(
    runningThreadCountAtom(
      restarts
        .filter((machine) => machine.continuesThreads)
        .map((machine) => machine.environmentId)
        .join("\n"),
    ),
  );
  const running = stopped + continuing;
  const restarting = new Set(restarts.map((machine) => machine.environmentId));
  const skipped = rows.filter((row) => row.skipped !== null);

  return (
    <>
      <AlertDialogHeader className="shrink-0">
        <AlertDialogTitle>
          {title ??
            gt("{count, plural, one {Update {count} machine?} other {Update {count} machines?}}", {
              count: selected.length,
            })}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {selectedVersion !== null ? (
            <>
              T3 Code <span className="font-mono text-xs">{selectedVersion}</span>
            </>
          ) : null}
          {selectedVersion !== null && selectedProviderCount > 0 ? " · " : null}
          {selectedProviderCount > 0
            ? gt(
                "{count, plural, one {{count} provider update} other {{count} provider updates}}",
                { count: selectedProviderCount },
              )
            : null}
          {checking
            ? `${selectedVersion !== null || selectedProviderCount > 0 ? " · " : ""}${gt("Checking for more…")}`
            : null}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <ScrollArea scrollFade>
        <div className="flex flex-col gap-3 px-6 pb-4">
          {notes.map((note) => (
            <p key={note} className="text-muted-foreground text-sm">
              {note}
            </p>
          ))}
          {selectable ? (
            <p className="text-muted-foreground text-sm">
              <T>
                Choose which machines to update. Only selected machines will be updated or
                restarted.
              </T>
            </p>
          ) : null}
          {/* Machine names truncate first. Provider lists wrap between names, never inside one. */}
          <div
            role="table"
            className="grid grid-cols-[minmax(4rem,max-content)_max-content_minmax(min-content,1fr)_max-content] gap-x-4 text-sm"
          >
            <div
              role="row"
              className="col-span-full grid grid-cols-subgrid border-b pb-1.5 text-muted-foreground text-xs"
            >
              <span role="columnheader">
                <T>Machine</T>
              </span>
              <span role="columnheader">T3 Code</span>
              <span role="columnheader">
                <T>Providers</T>
              </span>
              <span role="columnheader" />
            </div>
            {updating.map((row) => (
              <div
                key={row.environmentId ?? "this-app"}
                role="row"
                className="col-span-full grid grid-cols-subgrid border-b border-border/50 py-1.5 last:border-b-0"
              >
                <label role="cell" className="flex max-w-40 min-w-0 items-center gap-2">
                  {selectable ? (
                    <Checkbox
                      checked={!excluded.has(rowKey(row))}
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        setExcluded((previous) => {
                          const next = new Set(previous);
                          if (checked) next.delete(rowKey(row));
                          else next.add(rowKey(row));
                          return next;
                        })
                      }
                    />
                  ) : null}
                  <span className="sr-only">{row.label}</span>
                  <MiddleTruncate value={row.label} aria-hidden />
                </label>
                <span role="cell">
                  {row.app !== null ? m(APP_LABELS[row.app]) : null}
                  {row.app === null && row.skipped !== null ? (
                    <span className="text-muted-foreground">
                      <T>Skipped</T>
                    </span>
                  ) : null}
                  {row.app === "this-app" ? (
                    <span className="block text-muted-foreground text-xs">
                      <T>restarts last</T>
                    </span>
                  ) : null}
                </span>
                <span role="cell">
                  {row.providers.map((provider, index) => (
                    <Fragment key={provider}>
                      <span className="whitespace-nowrap">{provider}</span>
                      {index < row.providers.length - 1 ? ", " : null}
                    </Fragment>
                  ))}
                </span>
                <span role="cell" className="text-right">
                  {row.environmentId !== null && restarting.has(row.environmentId) ? (
                    <RunningThreads environmentId={row.environmentId} />
                  ) : null}
                </span>
              </div>
            ))}
          </div>
          {skipped.length > 0 ? (
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground data-panel-open:[&_svg]:rotate-90">
                <ChevronRightIcon className="size-3.5 transition-transform" aria-hidden />
                {gt("{count, plural, one {{count} skipped} other {{count} skipped}}", {
                  count: skipped.length,
                })}
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="grid grid-cols-[minmax(0,max-content)_1fr] gap-x-3 gap-y-0.5 pt-1.5 ps-4.5 text-muted-foreground text-xs">
                  {skipped.map((row) => (
                    <Fragment key={row.environmentId ?? "this-app"}>
                      <span className="max-w-32 min-w-0">
                        <MiddleTruncate value={row.label} />
                      </span>
                      <span className="wrap-anywhere">{row.skipped}</span>
                    </Fragment>
                  ))}
                </div>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}
        </div>
      </ScrollArea>
      <AlertDialogFooter>
        {disabledReason !== null ? (
          <p className="self-center text-sm max-sm:order-1 max-sm:text-center sm:mr-auto">
            {disabledReason}
          </p>
        ) : running > 0 ? (
          <p className="self-center text-muted-foreground text-sm max-sm:order-1 max-sm:text-center sm:mr-auto">
            {stopped === 0
              ? gt(
                  "{count, plural, one {{count} running thread will be interrupted and can resume after the restart.} other {{count} running threads will be interrupted and can resume after the restart.}}",
                  { count: running },
                )
              : continuing === 0
                ? gt(
                    "{count, plural, one {{count} running thread will be interrupted.} other {{count} running threads will be interrupted.}}",
                    { count: running },
                  )
                : `${gt(
                    "{count, plural, one {{count} running thread will be interrupted.} other {{count} running threads will be interrupted.}}",
                    { count: running },
                  )} ${gt(
                    "{count, plural, one {{count} can resume after the restart.} other {{count} can resume after the restart.}}",
                    { count: continuing },
                  )}`}
          </p>
        ) : null}
        <AlertDialogClose ref={cancelRef} render={<Button variant="outline" disabled={busy} />}>
          <T>Cancel</T>
        </AlertDialogClose>
        <Button
          disabled={disabledReason !== null || busy || (selectable && selected.length === 0)}
          onClick={() =>
            onConfirm(
              selectable
                ? {
                    environmentIds: [...selectedIds],
                    updateLocal: selected.some((row) => row.app === "this-app"),
                  }
                : undefined,
            )
          }
        >
          {confirmLabel ?? gt("Update", { $context: "verb, confirms the update" })}
        </Button>
      </AlertDialogFooter>
    </>
  );
}

function RunningThreads({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const count = useAtomValue(runningThreadCountAtom(environmentId));
  const gt = useGT();
  return count > 0 ? (
    <span className="whitespace-nowrap text-warning">
      {gt("{count, plural, one {{count} running} other {{count} running}}", { count })}
    </span>
  ) : null;
}
