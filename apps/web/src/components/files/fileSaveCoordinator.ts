import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";

export interface FileSaveRollback<A = unknown, E = unknown> {
  readonly failedContents: string;
  readonly confirmedContents: string;
  readonly result: AtomCommandResult<A, E> | null;
}

export interface FileSaveCoordinatorOptions<A, E> {
  readonly debounceMs: number;
  readonly initialContents: string;
  readonly persist: (contents: string) => Promise<AtomCommandResult<A, E>>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onConfirmed: (contents: string) => void;
  readonly onRollback: (rollback: FileSaveRollback<A, E>) => void;
}

export class FileSaveCoordinator<A = unknown, E = unknown> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private lastConfirmedContents: string;
  private latestRevision = 0;
  private lastChangeAt = 0;
  private saving = false;
  private disposed = false;

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {
    this.lastConfirmedContents = options.initialContents;
  }

  change(contents: string): void {
    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
    this.schedule(this.options.debounceMs);
  }

  syncConfirmed(contents: string): void {
    if (this.latestRevision === 0 && !this.saving) {
      this.lastConfirmedContents = contents;
    }
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
    if (this.saving || this.latestRevision === 0) return;

    this.saving = true;
    const contents = this.latestContents;
    const revision = this.latestRevision;
    let result: AtomCommandResult<A, E> | null = null;
    let succeeded = false;
    let interrupted = false;
    try {
      result = await this.options.persist(contents);
      succeeded = result._tag === "Success";
      interrupted = !succeeded && isAtomCommandInterrupted(result);
      if (succeeded) {
        this.lastConfirmedContents = contents;
        this.options.onConfirmed(contents);
      }
    } catch {
      succeeded = false;
      interrupted = false;
    }

    this.saving = false;
    if (revision === this.latestRevision) {
      if (interrupted) {
        return;
      }
      if (!succeeded) {
        this.latestRevision = 0;
        this.latestContents = this.lastConfirmedContents;
        this.options.onRollback({
          failedContents: contents,
          confirmedContents: this.lastConfirmedContents,
          result,
        });
        return;
      }
      this.latestRevision = 0;
      if (!this.disposed) this.options.onPendingChange(false);
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
