/**
 * The furniture of a timeline rail: the discs that sit on the line and the name that opens a row.
 * A marker is a lid over the line as much as it is a glyph — it paints the background over the rail
 * so the line appears to run behind it — which is why the sizes and the background are written once
 * here rather than guessed at twice.
 *
 * What each row *says* stays with the surface that knows the words for it.
 */
import type { SourceControlActor } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { SourceControlActorAvatar } from "./actorPresentation";

function TimelineMarker({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <span
      className={cn(
        "absolute left-0 top-1/2 z-10 flex size-8 -translate-y-1/2 items-center justify-center bg-background",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function IconMarker({
  icon,
  className,
}: {
  icon: ReactNode;
  className?: string | undefined;
}) {
  return (
    <TimelineMarker className={className}>
      <span className="flex size-7 items-center justify-center bg-background text-muted-foreground">
        {icon}
      </span>
    </TimelineMarker>
  );
}

export function ActorTimelineMarker({
  actors,
  className,
  fallback,
  muted = false,
}: {
  actors: ReadonlyArray<SourceControlActor>;
  className?: string | undefined;
  /** Drawn where the row has nobody to show a face for: a commit with no matched author. */
  fallback: ReactNode;
  muted?: boolean;
}) {
  const actor = actors[0];
  return actor === undefined ? (
    <IconMarker className={className} icon={fallback} />
  ) : (
    <TimelineMarker className={className}>
      <SourceControlActorAvatar
        actor={actor}
        className={cn(
          "size-7 bg-muted text-[9px] transition-opacity",
          muted && "opacity-45 grayscale",
        )}
      />
    </TimelineMarker>
  );
}

export function ActorName({ actor }: { actor: SourceControlActor | null }) {
  return <span className="font-semibold text-foreground">{actor?.login ?? "ghost"}</span>;
}

/** Who is in a run of comments, first appearance first: the face on the marker is the one who opened it. */
export function uniqueConversationActors(
  entries: ReadonlyArray<{ readonly actor: SourceControlActor | null }>,
) {
  const actors = new Map<string, SourceControlActor>();
  for (const entry of entries) {
    const actor = entry.actor;
    if (actor !== null && !actors.has(actor.login)) actors.set(actor.login, actor);
  }
  return [...actors.values()];
}
