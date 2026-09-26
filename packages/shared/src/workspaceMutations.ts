/**
 * Workspace mutation fold — the shared form of the native
 * `latestWorkspaceMutationId` signal. The web hook
 * (apps/web/src/hooks/useWorkspaceMutationRefresh.ts) scans the live
 * `OrchestrationThreadActivity[]`; the `t3.workspace/changes` adapter folds
 * the same activity kinds server-side so a plugin learns "the agent may have
 * written files" without raw provider payloads crossing the wire.
 *
 * An activity qualifies when it is a `tool.completed` row, or a
 * `tool.updated` row carrying a terminal status (anything other than
 * `inProgress`/`in_progress`), whose `payload.itemType` is
 * `command_execution` or `file_change`. Completed commands are included
 * because a shell command can mutate the workspace without reporting the
 * paths it touched.
 */

/** The minimal activity fields the fold reads; both the client projection and the server's row satisfy it. */
export interface WorkspaceMutationActivityLike {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly turnId: string | null;
  readonly sequence?: number | undefined;
  readonly createdAt: string;
}

/** The minimal turn fields the revert rule reads; `ProjectionTurn` and `OrchestrationCheckpointSummary` both qualify. */
export interface WorkspaceMutationTurnLike {
  readonly turnId: string | null;
  readonly checkpointTurnCount: number | null | undefined;
}

export type WorkspaceMutationItemType = "command_execution" | "file_change";

const WORKSPACE_MUTATION_ITEM_TYPES: ReadonlySet<string> = new Set([
  "command_execution",
  "file_change",
]);

/** The qualifying mutation kind for an activity, or null when it cannot have written workspace files. */
export function workspaceMutationItemType(
  activity: Pick<WorkspaceMutationActivityLike, "kind" | "payload">,
): WorkspaceMutationItemType | null {
  const payload =
    activity.payload !== null && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const terminalUpdate =
    activity.kind === "tool.updated" &&
    typeof payload?.status === "string" &&
    payload.status !== "inProgress" &&
    payload.status !== "in_progress";
  if (activity.kind !== "tool.completed" && !terminalUpdate) return null;
  const itemType = payload?.itemType;
  return typeof itemType === "string" && WORKSPACE_MUTATION_ITEM_TYPES.has(itemType)
    ? (itemType as WorkspaceMutationItemType)
    : null;
}

/**
 * The latest provider event after which files on disk may have changed —
 * a backward scan over the activity list in canonical order (ascending
 * `sequence` ?? `MAX_SAFE_INTEGER`, then `createdAt`, then `id`).
 */
export function latestWorkspaceMutationId(
  activities: ReadonlyArray<WorkspaceMutationActivityLike>,
): string | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity) continue;
    if (workspaceMutationItemType(activity) !== null) return activity.id;
  }
  return null;
}

/** The turn ids a revert to `turnCount` retains — mirrors both the client reducer and the projection pipeline. */
export function retainedTurnIdsAfterRevert(
  turns: ReadonlyArray<WorkspaceMutationTurnLike>,
  turnCount: number,
): ReadonlySet<string> {
  return new Set(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount !== undefined &&
          turn.checkpointTurnCount <= turnCount,
      )
      .map((turn) => turn.turnId!),
  );
}

function compareOrder(
  left: WorkspaceMutationActivityLike,
  right: WorkspaceMutationActivityLike,
): number {
  const leftSequence = left.sequence ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = right.sequence ?? Number.MAX_SAFE_INTEGER;
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Incremental form of the fold for a feed of activity-append, checkpoint,
 * and revert events. Rows are kept keyed by activity id so a re-delivered or
 * status-transitioning upsert replaces rather than duplicates — the same
 * semantics the client reducer applies to `thread.activity-appended`.
 * Only the folded latest id is exposed; payloads never leave the fold.
 */
export class WorkspaceMutationFold {
  private readonly rows = new Map<
    string,
    {
      readonly activity: WorkspaceMutationActivityLike;
      readonly itemType: WorkspaceMutationItemType;
    }
  >();
  private readonly checkpointTurnCounts = new Map<string, number>();
  private latestRow: {
    readonly activity: WorkspaceMutationActivityLike;
    readonly itemType: WorkspaceMutationItemType;
  } | null = null;

  get latestId(): string | null {
    return this.latestRow?.activity.id ?? null;
  }

  get latestItemType(): WorkspaceMutationItemType | null {
    return this.latestRow?.itemType ?? null;
  }

  /** Full rescan — reserved for invalidating changes (latest-row upsert/removal, revert, reset). */
  private recompute(): boolean {
    let newest: {
      activity: WorkspaceMutationActivityLike;
      itemType: WorkspaceMutationItemType;
    } | null = null;
    for (const row of this.rows.values()) {
      if (newest === null || compareOrder(newest.activity, row.activity) < 0) newest = row;
    }
    const changed = newest?.activity.id !== this.latestRow?.activity.id;
    this.latestRow = newest;
    return changed;
  }

  /** Seed from projected rows: the activities read (already kind-filtered upstream) plus the thread's turns. */
  seed(
    activities: ReadonlyArray<WorkspaceMutationActivityLike>,
    turns: ReadonlyArray<WorkspaceMutationTurnLike>,
  ): void {
    this.rows.clear();
    this.checkpointTurnCounts.clear();
    for (const turn of turns) {
      if (turn.turnId === null || turn.checkpointTurnCount === null) continue;
      if (turn.checkpointTurnCount === undefined) continue;
      this.checkpointTurnCounts.set(turn.turnId, turn.checkpointTurnCount);
    }
    // One insert pass plus a single maximum scan: seeding N rows costs N
    // comparisons, not the N(N-1)/2 a per-row rescan would burn synchronously
    // on the server's event loop.
    for (const activity of activities) {
      const itemType = workspaceMutationItemType(activity);
      if (itemType !== null) this.rows.set(activity.id, { activity, itemType });
    }
    this.recompute();
  }

  /** Fold one appended/upserted activity; returns true when the folded latest id changed. */
  applyActivity(activity: WorkspaceMutationActivityLike): boolean {
    const itemType = workspaceMutationItemType(activity);
    if (itemType === null) {
      // Removing any row but the current maximum cannot move the fold.
      const wasLatest = activity.id === this.latestId;
      if (!this.rows.delete(activity.id)) return false;
      return wasLatest ? this.recompute() : false;
    }
    this.rows.set(activity.id, { activity, itemType });
    // An upsert of the current maximum may have moved its order key either
    // way; only a rescan proves which row is newest. Every other case settles
    // with one comparison.
    if (activity.id === this.latestId) return this.recompute();
    if (this.latestRow !== null && compareOrder(this.latestRow.activity, activity) >= 0)
      return false;
    this.latestRow = { activity, itemType };
    return true;
  }

  /** Record a checkpoint's turn-count so a later revert retains the same turns the projection does. */
  applyCheckpoint(turnId: string, checkpointTurnCount: number): void {
    this.checkpointTurnCounts.set(turnId, checkpointTurnCount);
  }

  /** Mirror `thread.reverted`: keep only rows whose turn survives the checkpoint cutoff. */
  applyRevert(turnCount: number): boolean {
    const retained = retainedTurnIdsAfterRevert(
      [...this.checkpointTurnCounts].map(([turnId, checkpointTurnCount]) => ({
        turnId,
        checkpointTurnCount,
      })),
      turnCount,
    );
    let dropped = false;
    for (const [id, row] of this.rows) {
      if (row.activity.turnId !== null && !retained.has(row.activity.turnId)) {
        this.rows.delete(id);
        dropped = true;
      }
    }
    for (const turnId of this.checkpointTurnCounts.keys()) {
      if (!retained.has(turnId)) this.checkpointTurnCounts.delete(turnId);
    }
    return dropped ? this.recompute() : false;
  }

  /** Mirror the projection's `thread.created` row wipe. */
  reset(): boolean {
    if (this.rows.size === 0 && this.latestRow === null) return false;
    this.rows.clear();
    this.checkpointTurnCounts.clear();
    return this.recompute();
  }
}
