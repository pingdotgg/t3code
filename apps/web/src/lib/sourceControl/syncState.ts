/**
 * The ONE contextual remote button.
 *
 * A header carrying permanently-visible fetch / pull / push icons plus a
 * "diverged" banner plus publish and behind banners offers five affordances for
 * what is, at any moment, exactly one sensible next move against the remote.
 * This derives that one move from the status.
 */

import type { WorkingCopyStatus } from "./types";

export type SyncKind = "publish" | "push" | "pull" | "sync" | "fetch";

export interface SyncState {
  readonly kind: SyncKind;
  /** Button label, e.g. "Push 2" or "Sync ↑2↓1". */
  readonly label: string;
  /** Tooltip — the same thing said in words. */
  readonly title: string;
  /** The remote is out of step: render the button as the primary action. */
  readonly emphasis: boolean;
  readonly ahead: number;
  readonly behind: number;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

export function deriveSyncState(status: WorkingCopyStatus | null | undefined): SyncState {
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;

  // A detached HEAD has no branch to publish, push or pull; fetch is the only
  // remote verb that still means anything.
  if (!status || status.detached) {
    return {
      kind: "fetch",
      // fork: f4 F-02 — this rung does NOT run `git fetch`. It re-reads status
      // and asks the server to refresh its upstream view, which is rate-limited
      // by a server-side TTL. Labelling it "Fetch" made a no-op look broken;
      // "Refresh" is what it actually does.
      label: "Refresh",
      title: "Re-read this repository's status and upstream counts",
      emphasis: false,
      ahead,
      behind,
    };
  }

  if (!status.hasUpstream) {
    return {
      kind: "publish",
      label: "Publish",
      title: `Publish "${status.refName ?? "this branch"}" and set it to track the remote`,
      emphasis: true,
      ahead,
      behind,
    };
  }

  if (ahead > 0 && behind > 0) {
    return {
      kind: "sync",
      label: `Sync ↑${ahead}↓${behind}`,
      title: `Diverged — pull ${behind} then push ${ahead}`,
      emphasis: true,
      ahead,
      behind,
    };
  }

  if (ahead > 0) {
    return {
      kind: "push",
      label: `Push ${ahead}`,
      title: `Push ${ahead} ${plural(ahead, "commit")} to the remote`,
      emphasis: true,
      ahead,
      behind,
    };
  }

  if (behind > 0) {
    return {
      kind: "pull",
      label: `Pull ${behind}`,
      title: `Pull ${behind} ${plural(behind, "commit")} from the remote`,
      emphasis: true,
      ahead,
      behind,
    };
  }

  // fork: f4 F-02 — see the note on the detached branch above: this is a
  // status/upstream re-read, not `git fetch`.
  return {
    kind: "fetch",
    label: "Refresh",
    title: "Re-read this repository's status and upstream counts",
    emphasis: false,
    ahead,
    behind,
  };
}

/**
 * `↑2 ↓1` for the branch button, MINUS whatever the sync button already says.
 *
 * `↑26` next to a `Push 26` button is the same fact printed twice. The rule is
 * not "hide the hint" — Publish and Fetch state no figure at all, so under those
 * the counts are the only place a delta is visible. It is "do not repeat the
 * number the sync button has already stated": Push eats the ahead count, Pull
 * eats the behind count, Sync eats both.
 */
export function trackingHint(
  status: WorkingCopyStatus | null | undefined,
  sync: Pick<SyncState, "kind">,
): string {
  if (!status || status.detached) {
    return "";
  }
  const statesAhead = sync.kind === "push" || sync.kind === "sync";
  const statesBehind = sync.kind === "pull" || sync.kind === "sync";
  const parts: string[] = [];
  if (!statesAhead && (status.ahead ?? 0) > 0) {
    parts.push(`↑${status.ahead}`);
  }
  if (!statesBehind && (status.behind ?? 0) > 0) {
    parts.push(`↓${status.behind}`);
  }
  return parts.join(" ");
}
