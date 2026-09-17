/**
 * Work a draft has started but not finished — compressing a pasted image, downloading a pasted
 * attachment's bytes. Sending while any of it is outstanding snapshots a message whose chip has
 * nothing behind it, and the late result lands in whatever draft is open by then.
 *
 * Counted rather than flagged: two pastes can be in flight at once, and the first to finish must
 * not clear the second's claim.
 */
class PendingDraftWork {
  private readonly counts = new Map<string, number>();

  begin(draftKey: string): void {
    this.counts.set(draftKey, (this.counts.get(draftKey) ?? 0) + 1);
  }

  end(draftKey: string): void {
    const remaining = (this.counts.get(draftKey) ?? 0) - 1;
    if (remaining > 0) this.counts.set(draftKey, remaining);
    else this.counts.delete(draftKey);
  }

  has(draftKey: string): boolean {
    return (this.counts.get(draftKey) ?? 0) > 0;
  }
}

/**
 * Module-scoped, so a transfer keeps its claim on a draft across a remount of the composer.
 * Ownership belongs to the draft, which outlives any one mounted component; a per-instance
 * counter would come back empty while the download it was tracking was still running.
 */
export const pendingDraftWork = new PendingDraftWork();
