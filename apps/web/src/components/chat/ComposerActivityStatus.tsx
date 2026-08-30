import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";
import { ComposerBanner } from "./ComposerBanner";

export type ComposerActivityStatus =
  | { readonly kind: "working"; readonly startedAt: string | null }
  | { readonly kind: "sync"; readonly phase: ThreadSyncPhase };

export function ComposerActivityIcon({ status }: { readonly status: ComposerActivityStatus }) {
  if (status.kind !== "sync") return null;
  return (
    <ComposerBanner.Icon>
      <LoaderCircleIcon className="motion-safe:animate-spin" />
    </ComposerBanner.Icon>
  );
}

export function ComposerActivityRow({ status }: { readonly status: ComposerActivityStatus }) {
  return (
    <ComposerBanner.Row>
      <ComposerActivityIcon status={status} />
      <ComposerBanner.Content>
        <ComposerActivityLabel status={status} />
      </ComposerBanner.Content>
    </ComposerBanner.Row>
  );
}

export function ComposerActivityLabel({ status }: { readonly status: ComposerActivityStatus }) {
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

function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}
