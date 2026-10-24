import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

// Avoid unbounded retry traffic after a closed editor loses write access or its filesystem stays unavailable.
const MAX_CLOSE_RETRIES = 3;

export interface FileSaveCoordinatorOptions<A, E> {
  readonly debounceMs: number;
  readonly canPersist?: () => boolean;
  /** Refuse stale close-time retries after another editor replaces the draft. */
  readonly shouldRetryAfterClose?: (contents: string) => boolean;
  readonly persist: (contents: string) => Promise<AtomCommandResult<A, E>>;
  readonly onPendingChange: (pending: boolean) => void;
  /** Return false when another editor has newer unsaved contents. */
  readonly onConfirmed: (contents: string) => boolean | void;
}

export class FileSaveCoordinator<A = unknown, E = unknown> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private latestRevision = 0;
  private confirmedRevision = 0;
  private lastChangeAt = 0;
  private saving = false;
  private disposed = false;
  private closeRetryPending = false;
  private closeRetryFailures = 0;

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {}

  change(contents: string): void {
    if (this.disposed) return;
    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
    this.schedule(this.options.debounceMs);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    if (this.latestRevision > 0) void this.persistLatest();
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistLatest();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async persistLatest(): Promise<void> {
    if (this.saving || this.latestRevision === this.confirmedRevision) return;
    if (this.options.canPersist?.() === false) {
      return;
    }

    if (
      this.closeRetryPending &&
      this.options.shouldRetryAfterClose?.(this.latestContents) === false
    ) {
      return;
    }
    this.closeRetryPending = false;

    this.saving = true;
    const contents = this.latestContents;
    const revision = this.latestRevision;
    const result = await this.options.persist(contents);
    const succeeded = result._tag === "Success";
    let confirmed = false;
    if (succeeded) {
      this.confirmedRevision = revision;
      confirmed = this.options.onConfirmed(contents) !== false;
    }

    this.saving = false;
    if (revision === this.latestRevision) {
      if (confirmed) {
        this.closeRetryFailures = 0;
        this.options.onPendingChange(false);
      } else if (
        !succeeded &&
        this.disposed &&
        this.closeRetryFailures < MAX_CLOSE_RETRIES &&
        this.options.canPersist?.() !== false
      ) {
        // A permanent failure must not leave a disposed editor retrying forever.
        // Keep the unsaved draft pending after the bounded retry budget expires.
        this.closeRetryPending = true;
        const retryDelay = this.options.debounceMs * 2 ** this.closeRetryFailures;
        this.closeRetryFailures += 1;
        this.schedule(retryDelay);
      }
      return;
    }

    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt),
    );
    if (this.disposed) {
      void this.persistLatest();
    } else {
      this.schedule(remainingDebounce);
    }
  }
}
