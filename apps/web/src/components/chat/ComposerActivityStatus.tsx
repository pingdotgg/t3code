import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { PendingBackgroundWorkTask } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";
import { ComposerBanner } from "./ComposerBanner";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type ComposerActivityStatus =
  | { readonly kind: "working"; readonly startedAt: string | null }
  | { readonly kind: "sync"; readonly phase: ThreadSyncPhase }
  | { readonly kind: "waiting"; readonly tasks: ReadonlyArray<PendingBackgroundWorkTask> };

export function ComposerActivityIcon({ status }: { readonly status: ComposerActivityStatus }) {
  if (status.kind !== "sync") return null;
  return (
    <ComposerBanner.Icon>
      <LoaderCircleIcon className="motion-safe:animate-spin" />
    </ComposerBanner.Icon>
  );
}

export function ComposerActivityRow({
  status,
  onInterrupt,
}: {
  readonly status: ComposerActivityStatus;
  readonly onInterrupt?: () => void;
}) {
  return (
    <ComposerBanner.Row>
      <ComposerActivityIcon status={status} />
      <ComposerBanner.Content>
        <ComposerActivityLabel status={status} />
      </ComposerBanner.Content>
      {status.kind === "waiting" && onInterrupt ? (
        <ComposerBanner.Actions>
          <Button size="xs" variant="ghost" onClick={onInterrupt}>
            Stop
          </Button>
        </ComposerBanner.Actions>
      ) : null}
    </ComposerBanner.Row>
  );
}

export function ComposerActivityLabel({ status }: { readonly status: ComposerActivityStatus }) {
  if (status.kind === "waiting") {
    const label =
      status.tasks.length === 1
        ? "Waiting on background task"
        : `Waiting on ${status.tasks.length} background tasks`;
    const descriptions = status.tasks.map((task) => task.description || task.taskId);
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="block min-w-0 truncate text-muted-foreground"
              data-composer-waiting-status="true"
              tabIndex={0}
            >
              {label}: {descriptions.join(", ")}
            </span>
          }
        />
        <TooltipPopup side="top">
          {label}
          <ul className="list-disc pl-4">
            {status.tasks.map((task) => (
              <li key={task.taskId}>{task.description || task.taskId}</li>
            ))}
          </ul>
        </TooltipPopup>
      </Tooltip>
    );
  }
  if (status.kind === "sync") {
    return (
      <span
        className="shrink-0 whitespace-nowrap text-muted-foreground"
        data-composer-sync-status={status.phase}
        role="status"
      >
        {threadSyncLabel(status.phase)}
      </span>
    );
  }
  return (
    <span
      className="shrink-0 whitespace-nowrap text-muted-foreground"
      data-composer-working-status="true"
    >
      {status.startedAt ? (
        <>
          Working for <WorkingTimer createdAt={status.startedAt} />
        </>
      ) : (
        "Working…"
      )}
    </span>
  );
}

/** Updates only the elapsed text, without committing the composer or timeline each second. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}
