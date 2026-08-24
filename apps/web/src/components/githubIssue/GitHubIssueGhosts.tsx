/**
 * The issue detail panel opening. Bars sit in the geometry `GitHubIssueDetailContent` fills —
 * state glyph beside a title and its meta line, the action pair, label chips, the body card, then
 * the discussion — so the panel does not rearrange under the reader when the answer lands.
 *
 * Shares `GhostBar` and the single `animate-ghost-pulse` layer with the pull request ghosts rather
 * than the app's shimmer skeleton, for the reasons written up there.
 */
import { GhostBar } from "../pullRequest/PullRequestGhosts";

export function GitHubIssueDetailGhost() {
  return (
    <div
      role="status"
      aria-label="Loading issue"
      className="animate-ghost-pulse mx-auto w-full max-w-3xl px-5 py-6 sm:px-8"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <GhostBar className="mt-1 size-5 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <GhostBar className="h-5 w-4/5 max-w-md" />
            <GhostBar className="mt-2 w-3/5 max-w-xs" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <GhostBar className="h-8 w-32 rounded-md" />
          <GhostBar className="size-8 rounded-md" />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-1.5">
        <GhostBar className="h-5 w-16 rounded-full" />
        <GhostBar className="h-5 w-20 rounded-full" />
        <GhostBar className="h-5 w-14 rounded-full" />
      </div>

      <div className="mt-6 rounded-xl border border-border/70 p-4">
        <GhostBar className="w-full" />
        <GhostBar className="mt-2 w-11/12" />
        <GhostBar className="mt-2 w-3/4" />
      </div>

      <div className="mt-8">
        <GhostBar className="h-4 w-32" />
        <div className="mt-3 space-y-3">
          <div className="rounded-xl border border-border/70 p-4">
            <GhostBar className="w-40" />
            <GhostBar className="mt-3 w-full" />
            <GhostBar className="mt-2 w-2/3" />
          </div>
          <div className="rounded-xl border border-border/70 p-4">
            <GhostBar className="w-32" />
            <GhostBar className="mt-3 w-5/6" />
          </div>
        </div>
      </div>
    </div>
  );
}
