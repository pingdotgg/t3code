import { useState } from "react";
import { type EnvironmentId } from "@t3tools/contracts";
import { GitBranchIcon } from "lucide-react";
import { ThreadWorktreeIndicator } from "../ThreadStatusIndicators";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { SidebarThreadSummary } from "../../types";

function CheckoutDetails({
  environmentId,
  cwd,
  heading,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  heading: string;
}) {
  const query = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId,
      input: { cwd, includeRemote: false, includeCheckoutDetails: true },
    }),
  );
  const status = query.data;
  const details = status?.checkoutDetails;
  const date = (value: string | null) => (value ? new Date(value).toLocaleString() : "Unavailable");
  return (
    <div className="grid min-w-0 gap-1 text-xs">
      <div className="font-medium text-foreground">{heading}</div>
      <div className="break-all text-muted-foreground">{cwd}</div>
      {status?.isRepo === false ? (
        <div>No Git repository</div>
      ) : (
        <>
          <div>Branch: {status?.refName ?? "Loading…"}</div>
          <div>
            Version:{" "}
            <span className="font-mono">{details?.commit.slice(0, 10) ?? "Unavailable"}</span>
          </div>
          <div>Version committed: {date(details?.committedAt ?? null)}</div>
          <div>Checkout last updated: {date(details?.headUpdatedAt ?? null)}</div>
          <div>
            {details?.behindOriginMain == null
              ? "origin/main comparison unavailable"
              : details.behindOriginMain === 0
                ? "Up to date with origin/main"
                : `${details.behindOriginMain} commits behind origin/main`}
          </div>
          {status?.hasWorkingTreeChanges ? <div>Uncommitted changes</div> : null}
          <div className="text-muted-foreground">
            Compared with the locally fetched origin/main.
          </div>
        </>
      )}
      {query.error ? <div>{query.error}</div> : null}
    </div>
  );
}

export function SessionWorkspaceDetails({
  thread,
  workspaceRoot,
}: {
  thread: SidebarThreadSummary;
  workspaceRoot: string | null;
}) {
  const cwd = thread.worktreePath ?? workspaceRoot;
  return (
    <div className="grid min-w-0 gap-3">
      {cwd ? (
        <CheckoutDetails
          environmentId={thread.environmentId}
          cwd={cwd}
          heading={
            thread.worktreePath
              ? `Worktree: ${thread.worktreePath.split(/[\\/]/).at(-1)}`
              : "Main checkout"
          }
        />
      ) : (
        <span>Workspace unavailable</span>
      )}
      {thread.worktreePath && workspaceRoot && workspaceRoot !== cwd ? (
        <CheckoutDetails
          environmentId={thread.environmentId}
          cwd={workspaceRoot}
          heading="Main checkout"
        />
      ) : null}
    </div>
  );
}

export function SessionWorkspaceBadge({
  thread,
  workspaceRoot,
}: {
  thread: SidebarThreadSummary;
  workspaceRoot: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={150}
        render={
          <button
            type="button"
            onClick={(event) => event.stopPropagation()}
            className="inline-flex shrink-0 items-center gap-1"
            aria-label={thread.worktreePath ? "Worktree details" : "Main checkout details"}
          />
        }
      >
        {thread.worktreePath ? (
          <ThreadWorktreeIndicator thread={thread} />
        ) : (
          <GitBranchIcon aria-hidden className="size-3" />
        )}
        {thread.worktreePath ? "w" : "m"}
      </PopoverTrigger>
      <PopoverPopup tooltipStyle side="top" width="sm">
        <SessionWorkspaceDetails thread={thread} workspaceRoot={workspaceRoot} />
      </PopoverPopup>
    </Popover>
  );
}
