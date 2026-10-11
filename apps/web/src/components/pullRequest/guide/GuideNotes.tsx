import type { PullRequestReviewGuideNote } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { GuideProse } from "./GuideProse";

/** The letter that ties a note to its line in an excerpt. */
export function GuideNoteMarker({ marker }: { marker: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-4.5 shrink-0 items-center justify-center rounded-full bg-info/16 font-medium text-3xs text-info-foreground tabular-nums"
    >
      {marker}
    </span>
  );
}

/** A stop's notes, lettered in the order the excerpts mark them. */
export function GuideNotes({
  notes,
  className,
}: {
  notes: ReadonlyArray<{ readonly marker: string; readonly note: PullRequestReviewGuideNote }>;
  className?: string;
}) {
  if (notes.length === 0) return null;
  return (
    <section className={cn("flex min-w-0 flex-col gap-2", className)}>
      <h4 className="flex items-baseline justify-between gap-2 text-xs font-medium text-foreground">
        Notes on this stop
        <span className="font-normal text-muted-foreground tabular-nums">
          {notes.length === 1 ? "1 note" : `${notes.length} notes`}
        </span>
      </h4>
      <ol className="flex flex-col gap-3">
        {notes.map(({ marker, note }) => (
          <li key={marker} className="flex min-w-0 gap-2">
            <GuideNoteMarker marker={marker} />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="font-medium text-foreground">{note.title}</span>
                <span className="truncate font-mono text-2xs text-muted-foreground">
                  {note.path.split("/").at(-1)}:{note.line}
                </span>
              </p>
              {note.body.trim() !== "" ? (
                <div className="text-xs text-muted-foreground">
                  <GuideProse text={note.body} />
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
