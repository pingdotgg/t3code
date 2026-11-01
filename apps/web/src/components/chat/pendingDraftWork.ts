// Count per draft so overlapping pastes cannot release each other and strand chips.
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

// Keep claims across composer remounts.
export const pendingDraftWork = new PendingDraftWork();
