import { Spinner } from "~/components/ui/spinner";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import type { DesktopUpdateReleaseNote } from "@t3tools/contracts";
import { CircleAlertIcon, DownloadIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { loadServerUpdateReleaseNotes } from "~/serverUpdateReleaseNotes";
import { ReleaseNotesPanel } from "../ReleaseNotesPanel";
import { serverUpdateStageLabel } from "../ServerUpdateAction";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";

export function ComposerServerUpdateIcon({
  status,
}: {
  readonly status: ServerUpdateState["status"];
}) {
  if (status === "running") {
    return <Spinner aria-hidden />;
  }
  if (status === "failed") {
    return <CircleAlertIcon aria-hidden className="text-error" />;
  }
  return <DownloadIcon aria-hidden />;
}

/** One text line, clipped at the end so the error detail never squeezes its title. */
export function ComposerServerUpdateStatus({
  state,
  serverLabel = "server",
}: {
  readonly state: Exclude<ServerUpdateState, { status: "idle" }>;
  readonly serverLabel?: string;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const triggerId = useId();
  const title = `${state.status === "failed" ? "Could not update" : "Updating"} ${serverLabel}`;
  const detail = state.status === "failed" ? state.message : serverUpdateStageLabel(state.stage);
  return (
    <span
      role={state.status === "failed" ? "alert" : "status"}
      className="min-w-0"
      data-composer-server-update-status={state.status}
    >
      <Tooltip open={detailsOpen} onOpenChange={setDetailsOpen} triggerId={triggerId}>
        <TooltipTrigger
          id={triggerId}
          closeOnClick={false}
          render={
            <button
              type="button"
              aria-label={`${title}: ${detail}`}
              className="block max-w-full cursor-help truncate rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setDetailsOpen(true)}
            >
              {title}
              <ComposerBanner.Separator />
              <span className="font-normal text-muted-foreground">{detail}</span>
            </button>
          }
        />
        <TooltipPopup side="top">
          {title}: {detail}
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}

interface ServerUpdateVersions {
  readonly serverLabel: string;
  readonly serverVersion: string;
  readonly targetVersion: string;
}

function ServerUpdateReleaseNotes({
  serverLabel,
  serverVersion,
  targetVersion,
}: ServerUpdateVersions) {
  const [releaseNotes, setReleaseNotes] = useState<ReadonlyArray<DesktopUpdateReleaseNote>>([]);
  useEffect(() => {
    let current = true;
    void loadServerUpdateReleaseNotes(targetVersion).then((notes) => {
      if (current) setReleaseNotes(notes);
    });
    return () => {
      current = false;
    };
  }, [targetVersion]);

  return (
    <ReleaseNotesPanel
      header={
        <>
          <div className="text-sm leading-5 font-medium">Server update available</div>
          <div className="mt-0.5 text-xs leading-4 text-muted-foreground">
            {serverLabel} {serverVersion} <span aria-hidden="true">→</span> {targetVersion}
          </div>
        </>
      }
      omittedReleaseCount={0}
      releaseNotes={releaseNotes}
      shell={window.desktopBridge}
    />
  );
}

/** Banner title that opens what the server update brings. Notes load on first open. */
export function ComposerServerUpdateAvailable(props: ServerUpdateVersions) {
  return (
    <Popover>
      <PopoverTrigger render={<InlineButton />} className="max-w-full">
        <span className="min-w-0 truncate">Server update available</span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" tooltipStyle initialFocus={false}>
        <ServerUpdateReleaseNotes {...props} />
      </PopoverPopup>
    </Popover>
  );
}
