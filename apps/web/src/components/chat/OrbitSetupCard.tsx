import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  PencilIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useInstanceLinkContextMenu } from "~/orbit/useInstanceLinkContextMenu";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import {
  ORBIT_INSTANCE_STAYS_LINE,
  ORBIT_SETUP_FAILED_TITLE,
  type OrbitReadyView,
  type OrbitSetupView,
  type OrbitSetupViewRow,
  type OrbitSetupViewStage,
} from "~/orbit/orbitSetupView";
import { OrbitInstanceUrlChip } from "../BranchToolbarEnvModeSelector";
import type { OrbitReadyTimelineInput } from "./MessagesTimeline.logic";
import { WorkLogRow } from "./WorkLog";
import { ShimmerOverlay, StageIcon, stageRowClassName } from "./WorktreeSetupCard";

/** A row's status icon, at the right end of the row (today's icons and sizes). */
function RowStatus({
  status,
  small = false,
}: {
  status: OrbitSetupViewStage["status"];
  small?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex w-6 shrink-0 items-center justify-center",
        status === "failed" ? "text-destructive-foreground" : "text-icon-muted",
        small && "[&_svg]:size-3.5",
        status === "pending" && "opacity-40",
      )}
      data-orbit-row-icon
    >
      <StageIcon status={status} />
    </span>
  );
}

function RowLabel({
  label,
  status,
  small = false,
}: {
  label: string;
  status: OrbitSetupViewStage["status"];
  small?: boolean;
}) {
  const running = status === "running";
  return (
    <span
      ref={running ? observeVisibleAnimation : undefined}
      className={cn("relative block truncate", small && "text-xs", stageRowClassName(status))}
    >
      {label}
      {running ? <ShimmerOverlay>{label}</ShimmerOverlay> : null}
    </span>
  );
}

/**
 * Conn: the setup card of a thread started in an Orbit Project, in the look of WorktreeSetupCard.
 * It renders a client-built view, so the worktree wire contract stays as it is. Every row has its
 * status icon at the right end and no timing.
 */
function OrbitStageRow({ stage }: { stage: OrbitSetupViewStage }) {
  return (
    <WorkLogRow
      data-orbit-setup-stage={stage.id}
      data-orbit-setup-status={stage.status}
      label={
        <RowLabel
          label={stage.label}
          // "Create Instance" shows the card's failure with its X only; its rows say where.
          status={stage.id === "create" && stage.status === "failed" ? "done" : stage.status}
        />
      }
      trailing={
        <>
          {stage.detail ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{stage.detail}</span>
          ) : null}
          <RowStatus status={stage.status} />
        </>
      }
    />
  );
}

/** One of the four rows of Orbit's create steps under "Create Instance". */
function OrbitCreateRow({ row }: { row: OrbitSetupViewRow }) {
  return (
    <WorkLogRow
      data-orbit-create-row={row.id}
      data-orbit-create-status={row.status}
      label={<RowLabel label={row.label} status={row.status} small />}
      trailing={
        <>
          {row.detail ? (
            <span
              className="min-w-0 truncate text-xs text-muted-foreground/70"
              data-orbit-create-row-detail
            >
              {row.detail}
            </span>
          ) : null}
          <RowStatus status={row.status} small />
        </>
      }
    />
  );
}

/** The Details grid of the setup card: label and value pairs, the same while it runs and once ready. */
function OrbitDetailsGrid({ children }: { children: ReactNode }) {
  return (
    <dl
      className="mt-1 mb-1.5 ml-0.5 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
      data-orbit-setup-details
    >
      {children}
    </dl>
  );
}

function DetailsFact({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <>
      <dt className="text-foreground/80">{label}</dt>
      <dd className="min-w-0 truncate font-mono">{value}</dd>
    </>
  );
}

function DetailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Button type="button" size="xs" variant="ghost-muted" aria-expanded={open} onClick={onToggle}>
      {open ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
      Details
    </Button>
  );
}

export function OrbitSetupCard({
  view,
  onRetry,
  onChangeName,
  onChangeBranch,
  onOpenInstance,
  onDismiss,
  onCancel,
}: {
  view: OrbitSetupView;
  onRetry: () => void;
  onChangeName: () => void;
  onChangeBranch: () => void;
  onOpenInstance: (instance: { readonly id: number; readonly name: string }) => void;
  onDismiss: () => void;
  onCancel: () => void;
}) {
  const failed = view.phase === "failed";
  // Details and Cancel show only before the thread opens; in the thread the card follows the address.
  const live = view.phase === "running" && (view.canCancel || view.cancelling);
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <section aria-label="Instance setup" data-orbit-setup-phase={view.phase}>
      {failed ? (
        <div className="border-b border-(--shell-divider)! pb-2 pt-1">
          <div className="flex h-6 items-baseline px-1 text-sm leading-relaxed text-destructive-foreground">
            {ORBIT_SETUP_FAILED_TITLE}
          </div>
        </div>
      ) : null}
      <div className={failed ? "pt-1.5" : undefined}>
        {view.stages.map((stage) => (
          <div key={stage.id}>
            <OrbitStageRow stage={stage} />
            {stage.rows ? (
              <div className="mb-1 ml-0.5 border-l border-border pl-3">
                {stage.rows.map((row) => (
                  <OrbitCreateRow key={row.id} row={row} />
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {failed && view.error ? (
        <p className="mt-1 ml-3.5 text-xs break-words text-muted-foreground">{view.error}</p>
      ) : null}
      {failed && view.errorDetailLine ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <p
                className="mt-0.5 ml-3.5 truncate font-mono text-xs text-muted-foreground/70"
                data-orbit-setup-error-detail
              />
            }
          >
            {view.errorDetailLine}
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-96">
            <span className="break-words font-mono">{view.errorDetailLine}</span>
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {view.instanceStays ? (
        <p className="mt-1 ml-3.5 text-xs text-muted-foreground">{ORBIT_INSTANCE_STAYS_LINE}</p>
      ) : null}
      {live ? (
        <>
          <div className="mt-0.5 -ml-1.5 flex items-center gap-0.5">
            <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen((open) => !open)} />
            {view.cancelling ? (
              <span className="px-2 text-xs text-muted-foreground" data-orbit-setup-cancelling>
                Cancelling…
              </span>
            ) : view.canCancel ? (
              <Button type="button" size="xs" variant="ghost-muted" onClick={onCancel}>
                <XIcon aria-hidden />
                Cancel
              </Button>
            ) : null}
          </div>
          {detailsOpen ? (
            <OrbitDetailsGrid>
              <DetailsFact label="Instance" value={view.details.instanceName} />
              <DetailsFact label="Node" value={view.details.nodeName} />
              <DetailsFact label="Branch" value={view.details.branch} />
              <DetailsFact label="Base" value={view.details.baseBranch} />
              <DetailsFact label="URL" value={view.details.url} />
            </OrbitDetailsGrid>
          ) : null}
        </>
      ) : null}
      {failed ? (
        <div className="mt-1 -ml-1.5 flex flex-wrap items-center gap-0.5">
          {view.canRetry ? (
            <Button type="button" size="xs" variant="ghost-muted" onClick={onRetry}>
              <RotateCcwIcon aria-hidden />
              Retry
            </Button>
          ) : null}
          {view.canChangeName ? (
            <Button type="button" size="xs" variant="ghost-muted" onClick={onChangeName}>
              <PencilIcon aria-hidden />
              Change name
            </Button>
          ) : null}
          {view.canChangeBranch ? (
            <Button type="button" size="xs" variant="ghost-muted" onClick={onChangeBranch}>
              <GitBranchIcon aria-hidden />
              Change branch
            </Button>
          ) : null}
          {view.openInstance ? (
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              onClick={() => onOpenInstance(view.openInstance!)}
            >
              <ExternalLinkIcon aria-hidden />
              Open {view.openInstance.name}
            </Button>
          ) : null}
          <Button type="button" size="xs" variant="ghost-muted" onClick={onDismiss}>
            <XIcon aria-hidden />
            Dismiss
          </Button>
        </div>
      ) : null}
    </section>
  );
}

const noop = () => {};

/**
 * The real thread's Orbit row: the setup card while the create's completion runs or failed (no
 * Cancel; Retry and Dismiss when it failed), else the "Instance ready" row.
 */
export function OrbitThreadSetupRow({ ready }: { ready: OrbitReadyTimelineInput }) {
  if (!ready.setup) return <OrbitReadyRow view={ready.view} threadRef={ready.threadRef} />;
  return (
    <OrbitSetupCard
      view={ready.setup}
      onRetry={ready.onRetry ?? noop}
      onChangeName={noop}
      onChangeBranch={noop}
      onOpenInstance={noop}
      onDismiss={ready.onDismiss ?? noop}
      onCancel={noop}
    />
  );
}

/** The real thread's folded "Instance ready" row, its Details (open by default) and Conn's line. */
export function OrbitReadyRow({
  view,
  threadRef,
}: {
  view: OrbitReadyView;
  threadRef: ScopedThreadRef;
}) {
  const [detailsOpen, setDetailsOpen] = useState(true);
  const openLink = useOpenLink(threadRef);
  const showLinkMenu = useInstanceLinkContextMenu(threadRef);
  const label = "Instance ready";
  return (
    <section aria-label="Instance setup" data-orbit-ready>
      <WorkLogRow
        data-orbit-setup-stage="summary"
        data-orbit-setup-status="done"
        label={<span className={stageRowClassName("done")}>{label}</span>}
        trailing={<RowStatus status="done" />}
      />
      <div className="mt-0.5 -ml-1.5 flex items-center">
        <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen((open) => !open)} />
      </div>
      {detailsOpen ? (
        <OrbitDetailsGrid>
          {view.url ? (
            <>
              <dt className="text-foreground/80">Preview</dt>
              <dd className="flex min-w-0">
                <OrbitInstanceUrlChip url={view.url} threadRef={threadRef} />
              </dd>
            </>
          ) : null}
          <DetailsFact label="Instance" value={view.instanceName} />
          <DetailsFact label="Node" value={view.nodeName} />
          <DetailsFact label="Branch" value={view.branch} />
          <DetailsFact label="Base" value={view.baseBranch} />
        </OrbitDetailsGrid>
      ) : null}
      {view.dependenciesLine ? (
        <p className="mb-1 ml-3.5 text-xs text-muted-foreground" data-orbit-dependencies-line>
          {view.dependenciesLine}
        </p>
      ) : null}
      {view.modelFallbackLine ? (
        <p className="mb-1 ml-3.5 text-xs text-muted-foreground" data-orbit-model-fallback>
          {view.modelFallbackLine}
        </p>
      ) : null}
      <p
        className="mt-3 text-sm leading-relaxed text-foreground"
        data-orbit-ready-line
        data-message-role="conn"
      >
        {view.url ? (
          <>
            Your Instance is ready. You can preview it at{" "}
            <a
              href={view.url}
              className="underline underline-offset-2"
              onClick={(event) => {
                event.preventDefault();
                void openLink(view.url!, { event }).catch((error: unknown) => console.error(error));
              }}
              onContextMenu={(event) => showLinkMenu(event, view.url!)}
            >
              {view.url}
            </a>{" "}
            while I work on your request.
          </>
        ) : (
          view.readyLine
        )}
      </p>
    </section>
  );
}
