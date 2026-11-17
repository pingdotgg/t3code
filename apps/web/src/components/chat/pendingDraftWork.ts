// Count per draft so overlapping pastes cannot release each other and strand chips.
class PendingDraftWork {
  private readonly counts = new Map<string, number>();
  // Chips whose bytes are still downloading; a paste of one has no record yet but will.
  private readonly contextIds = new Map<string, Set<string>>();

  begin(draftKey: string, contextId?: string): void {
    this.counts.set(draftKey, (this.counts.get(draftKey) ?? 0) + 1);
    if (contextId !== undefined) {
      this.contextIds.set(draftKey, (this.contextIds.get(draftKey) ?? new Set()).add(contextId));
    }
  }

  end(draftKey: string, contextId?: string): void {
    const remaining = (this.counts.get(draftKey) ?? 0) - 1;
    if (remaining > 0) this.counts.set(draftKey, remaining);
    else this.counts.delete(draftKey);
    const contextIds = this.contextIds.get(draftKey);
    if (contextId !== undefined && contextIds?.delete(contextId) && contextIds.size === 0) {
      this.contextIds.delete(draftKey);
    }
  }

  has(draftKey: string): boolean {
    return (this.counts.get(draftKey) ?? 0) > 0;
  }

  importingContextIds(draftKey: string): ReadonlySet<string> {
    return this.contextIds.get(draftKey) ?? new Set();
  }
}

// Keep claims across composer remounts.
export const pendingDraftWork = new PendingDraftWork();
