/**
 * Loading states specific to the pull request surface — the first list, a search under way,
 * and a detail panel opening — use bars in the geometry of the content they stand for, pulsing
 * on one composited layer. Diff loading uses the shared diff-panel skeleton instead.
 *
 * The bars share the app-wide `Skeleton` tone (`muted-foreground` at low alpha, which reads on
 * both themes) and the single `animate-skeleton` pulse, applied once on the container so any
 * number of bars costs one opacity animation.
 */
import { cn } from "~/lib/utils";

function GhostBar({ className }: { className?: string | undefined }) {
  return <div aria-hidden className={cn("h-3 rounded bg-muted-foreground/15", className)} />;
}

/** Widths cycle rather than randomize, so the ghost renders the same on every pass. */
const TITLE_WIDTHS = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-2/5", "w-3/5", "w-1/2"];
const META_WIDTHS = ["w-2/5", "w-1/3", "w-2/5", "w-1/4", "w-1/3", "w-2/5", "w-1/3"];

/** Rows in the list's own grid — glyph, title over meta, time over diffstat. */
export function PullRequestListGhost({
  rows = 7,
  caption,
}: {
  rows?: number;
  /** Said where the group headers speak, for the states with something to say — a search. */
  caption?: string;
}) {
  return (
    <div
      role="status"
      aria-label={caption ?? "Loading pull requests"}
      className="motion-safe:animate-skeleton space-y-0.5"
    >
      {caption ? (
        <p className="px-3 pb-1 text-xs font-medium text-muted-foreground/70">{caption}</p>
      ) : null}
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2"
        >
          <GhostBar className="size-4 rounded-full" />
          <div className="min-w-0 space-y-1.5">
            <GhostBar className={cn("h-3.5", TITLE_WIDTHS[index % TITLE_WIDTHS.length])} />
            <GhostBar className={META_WIDTHS[index % META_WIDTHS.length]} />
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <GhostBar className="w-12" />
            <GhostBar className="w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The detail panel's current expanded shape. Keeping the chrome, summary facts, and description
 * boundaries in the ghost prevents the loaded pull request from replacing one layout with
 * another a moment later.
 */
export function PullRequestDetailGhost() {
  return (
    <div
      role="status"
      aria-label="Loading pull request"
      className="motion-safe:animate-skeleton flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      <div className="shrink-0 border-b border-border/60">
        <div className="flex h-7 items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <GhostBar className="w-24" />
            <GhostBar className="w-9" />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <GhostBar className="h-5 w-16 rounded-md" />
            <GhostBar className="size-5 rounded-md" />
          </div>
        </div>

        <div className="px-4 pb-4 pt-1">
          <GhostBar className="h-5 w-4/5 max-w-md" />
          <div className="mt-2 flex items-center gap-1.5">
            <GhostBar className="size-4 rounded-full" />
            <GhostBar className="w-24" />
          </div>
          <div className="mt-4 flex min-w-0 items-center gap-2">
            <GhostBar className="h-6 w-24 rounded-md" />
            <GhostBar className="size-3 rounded-full" />
            <GhostBar className="h-6 w-32 rounded-md" />
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <GhostBar className="w-10" />
              <GhostBar className="w-20" />
            </div>
          </div>
        </div>

        <div className="flex min-h-10 items-center justify-between gap-3 border-t border-border/60 px-4 py-2">
          <div className="flex items-center gap-1 p-0.5">
            <GhostBar className="h-6 w-16 rounded-md" />
            <GhostBar className="h-6 w-16 rounded-md" />
            <GhostBar className="h-6 w-12 rounded-md" />
          </div>
          <GhostBar className="w-20" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <section className="px-4 py-3">
          <div className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2">
            <div className="flex items-center gap-1.5">
              <GhostBar className="size-3.5 rounded-full" />
              <GhostBar className="w-14" />
            </div>
            <div className="flex items-center gap-1">
              <GhostBar className="size-4 rounded-full" />
              <GhostBar className="size-4 rounded-full" />
              <GhostBar className="ml-1 size-5 rounded-md" />
            </div>
          </div>
          <div className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2">
            <div className="flex items-center gap-1.5">
              <GhostBar className="size-3.5 rounded-full" />
              <GhostBar className="w-10" />
            </div>
            <div className="flex items-center gap-1">
              <GhostBar className="h-5 w-24 rounded-full" />
              <GhostBar className="h-5 w-20 rounded-full" />
            </div>
          </div>
          <div className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2">
            <div className="flex items-center gap-1.5">
              <GhostBar className="size-3.5 rounded-full" />
              <GhostBar className="w-14" />
            </div>
            <GhostBar className="w-20" />
          </div>
        </section>

        <section className="border-t border-border/60">
          <div className="flex min-h-11 items-center gap-1.5 px-4 py-3">
            <GhostBar className="h-4 w-24" />
            <GhostBar className="size-3.5 rounded-full" />
          </div>
          <div className="space-y-2 px-4 pb-4">
            <GhostBar className="w-full" />
            <GhostBar className="w-11/12" />
            <GhostBar className="w-4/5" />
            <GhostBar className="w-2/3" />
          </div>
        </section>
      </div>
    </div>
  );
}

/** People-shaped: an avatar and a name, in the reviewer picker's own row height. */
export function PullRequestPeopleGhost({ rows = 4 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading people"
      className="motion-safe:animate-skeleton space-y-1 p-1"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-7 items-center gap-2 rounded-md px-2">
          <GhostBar className="size-4 rounded-full" />
          <GhostBar className={META_WIDTHS[index % META_WIDTHS.length]} />
        </div>
      ))}
    </div>
  );
}

/** The timeline's own shape: dots on the rail, a line and a date to each. */
export function PullRequestTimelineGhost({ rows = 6 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading timeline"
      className="motion-safe:animate-skeleton px-4 py-5"
    >
      <div className="relative ml-2 border-l border-border/70 pl-5">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="relative pb-5">
            <GhostBar className="absolute -left-[1.55rem] top-1 size-2 rounded-full" />
            <GhostBar className={cn("h-3.5", TITLE_WIDTHS[index % TITLE_WIDTHS.length])} />
            <GhostBar className="mt-1.5 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A compact placeholder for the conversation while the core detail is already readable. */
export function PullRequestConversationGhost({ rows = 3 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading pull request conversation"
      className="motion-safe:animate-skeleton space-y-4 py-2"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-start gap-2">
          <GhostBar className="size-5 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <GhostBar className={META_WIDTHS[index % META_WIDTHS.length]} />
            <GhostBar className="w-full" />
            <GhostBar className="w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}
