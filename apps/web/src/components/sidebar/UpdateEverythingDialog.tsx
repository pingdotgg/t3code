import { i18n } from "../../i18nCore";
import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { ChevronRightIcon } from "lucide-react";
import { Fragment, type RefObject, useRef } from "react";

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
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ScrollArea } from "../ui/scroll-area";
import type { RestartingMachine, UpdateEverythingRow } from "./updateEverything.logic";

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
  readonly onConfirm: () => void;
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

const APP_LABEL_KEYS = {
  "this-app": "updateDialog.thisApp",
  server: "updateDialog.server",
  "desktop-app": "updateDialog.desktopApp",
} as const;

function UpdateEverythingDialogContent({
  version,
  providerCount,
  rows,
  restarts,
  onConfirm,
  cancelRef,
  title,
  confirmLabel,
  notes = [],
  disabledReason = null,
  busy = false,
  checking = false,
}: UpdateEverythingDialogContentProps) {
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
  const threads = i18n.t("sidebar:updateDialog.threadsRunning", { count: running });
  const restarting = new Set(restarts.map((machine) => machine.environmentId));
  const updating = rows.filter((row) => row.app !== null || row.providers.length > 0);
  const skipped = rows.filter((row) => row.skipped !== null);

  return (
    <>
      <AlertDialogHeader className="shrink-0">
        <AlertDialogTitle>
          {title ?? i18n.t("sidebar:updateDialog.title", { count: updating.length })}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {version !== null ? (
            <>
              T3 Code <span className="font-mono text-xs">{version}</span>
            </>
          ) : null}
          {version !== null && providerCount > 0 ? " · " : null}
          {providerCount > 0
            ? i18n.t("sidebar:updateDialog.providerUpdates", { count: providerCount })
            : null}
          {checking
            ? `${version !== null || providerCount > 0 ? " · " : ""}${i18n.t("sidebar:updateDialog.checkingForMore")}`
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
          {/* Machine names truncate first. Provider lists wrap between names, never inside one. */}
          <div className="grid grid-cols-[minmax(4rem,max-content)_max-content_minmax(min-content,1fr)_max-content] gap-x-4 text-sm">
            <div className="col-span-full grid grid-cols-subgrid border-b pb-1.5 text-muted-foreground text-xs">
              <span>{i18n.t("sidebar:updateDialog.machine")}</span>
              <span>T3 Code</span>
              <span>{i18n.t("sidebar:updateDialog.providers")}</span>
              <span />
            </div>
            {updating.map((row) => (
              <div
                key={row.environmentId ?? "this-app"}
                className="col-span-full grid grid-cols-subgrid border-b border-border/50 py-1.5 last:border-b-0"
              >
                <span className="max-w-32 min-w-0">
                  <MiddleTruncate value={row.label} />
                </span>
                <span>
                  {row.app !== null ? i18n.t(`sidebar:${APP_LABEL_KEYS[row.app]}`) : null}
                  {row.app === null && row.skipped !== null ? (
                    <span className="text-muted-foreground">
                      {i18n.t("sidebar:updateDialog.skipped")}
                    </span>
                  ) : null}
                  {row.app === "this-app" ? (
                    <span className="block text-muted-foreground text-xs">
                      {i18n.t("sidebar:updateDialog.restartsLast")}
                    </span>
                  ) : null}
                </span>
                <span>
                  {row.providers.map((provider, index) => (
                    <Fragment key={provider}>
                      <span className="whitespace-nowrap">{provider}</span>
                      {index < row.providers.length - 1 ? ", " : null}
                    </Fragment>
                  ))}
                </span>
                <span className="text-right">
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
                {i18n.t("sidebar:updateDialog.skippedCount", { count: skipped.length })}
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
              ? i18n.t("sidebar:updateDialog.interruptResume", { threads })
              : continuing === 0
                ? i18n.t("sidebar:updateDialog.interrupted", { threads })
                : i18n.t("sidebar:updateDialog.interruptedResume", { threads, count: continuing })}
          </p>
        ) : null}
        <AlertDialogClose ref={cancelRef} render={<Button variant="outline" disabled={busy} />}>
          {i18n.t("sidebar:updateDialog.cancel")}
        </AlertDialogClose>
        <Button disabled={disabledReason !== null || busy} onClick={onConfirm}>
          {confirmLabel ?? i18n.t("sidebar:updateDialog.confirm")}
        </Button>
      </AlertDialogFooter>
    </>
  );
}

function RunningThreads({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const count = useAtomValue(runningThreadCountAtom(environmentId));
  return count > 0 ? <span className="whitespace-nowrap text-warning">{count} running</span> : null;
}
