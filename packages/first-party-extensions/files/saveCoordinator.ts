/**
 * Package-owned save coordinator. Mirrors the observable semantics of
 * the native panel's FileSaveCoordinator — 500 ms debounce, single-flight
 * serial persist, pending cleared only when the persisted edit is the latest
 * one and it succeeded, dispose() flushing pending edits immediately — adapted
 * to the revisioned compare-and-swap of `t3.workspace/text-edits@1.1.0`.
 *
 * The native persist is last-write-wins; the public contract carries an
 * `expectedRevision`, so the coordinator also tracks the confirmed base
 * revision and exposes the outcomes the wire can honestly produce: `saved`
 * advances the base, `conflict` halts autosave until the user resolves it,
 * and a thrown transport error surfaces as `error` with pending left set.
 */

export type PersistOutcome =
  | { readonly kind: "saved"; readonly revision: string }
  | { readonly kind: "conflict" }
  | { readonly kind: "error"; readonly message: string };

export type EditorSaveState =
  | { readonly kind: "clean" }
  | { readonly kind: "dirty" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
  | { readonly kind: "conflict" }
  | { readonly kind: "error"; readonly message: string };

export interface FileEditCoordinatorOptions {
  /** Native FILE_SAVE_DEBOUNCE_MS is 500; injected for tests. */
  readonly debounceMs: number;
  /**
   * One revisioned write. Receives the latest buffered contents and the
   * coordinator's confirmed base revision; must resolve to a PersistOutcome —
   * the coordinator never throws out of persist failures, the caller maps
   * transport errors to `{kind:"error"}`.
   */
  readonly persist: (contents: string, expectedRevision: string) => Promise<PersistOutcome>;
  /** Called when a persist confirms: the plugin's optimistic-confirm hook. */
  readonly onConfirmed?: (contents: string, revision: string) => void;
  readonly onStateChange?: (state: EditorSaveState) => void;
  readonly now?: () => number;
}

export class FileEditCoordinator {
  private readonly options: FileEditCoordinatorOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private latestRevision = 0;
  private confirmedRevision = 0;
  private baseRevision = "";
  private lastChangeAt = 0;
  private saving = false;
  private disposed = false;
  private conflicted = false;
  private lastError: string | null = null;

  constructor(options: FileEditCoordinatorOptions) {
    this.options = options;
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private get pending(): boolean {
    return this.latestRevision !== this.confirmedRevision;
  }

  state(): EditorSaveState {
    if (this.conflicted) return { kind: "conflict" };
    if (this.saving) return { kind: "saving" };
    if (this.pending) {
      return this.lastError !== null
        ? { kind: "error", message: this.lastError }
        : { kind: "dirty" };
    }
    if (this.confirmedRevision > 0) return { kind: "saved" };
    return { kind: "clean" };
  }

  private notify(): void {
    this.options.onStateChange?.(this.state());
  }

  /** The revision saves compare against — seeded from `readSnapshot`. */
  seed(revision: string, contents = ""): void {
    if (this.disposed) return;
    this.baseRevision = revision;
    this.latestContents = contents;
    this.latestRevision = 0;
    this.confirmedRevision = 0;
    this.conflicted = false;
    this.lastError = null;
    this.notify();
  }

  change(contents: string): void {
    if (this.disposed) return;
    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = this.now;
    this.lastError = null;
    // Once conflicted, autosave stays halted — further edits buffer so the
    // user's work is never discarded, but nothing writes over a changed file
    // until the conflict is resolved explicitly.
    if (!this.conflicted) this.schedule(this.options.debounceMs);
    this.notify();
  }

  /** Current buffered contents (what the editor shows). */
  contents(): string {
    return this.latestContents;
  }

  /**
   * Refresh reconciliation: the view re-read the snapshot and reports
   * the remote revision. Clean sessions adopt the remote file via the view;
   * dirty sessions latch conflict rather than clobber pending edits.
   */
  noteRemoteRevision(revision: string): void {
    if (this.disposed || this.conflicted) return;
    if (revision !== this.baseRevision && this.pending) {
      this.conflicted = true;
      this.clearTimer();
      this.notify();
    }
  }

  /** Resolve a conflict by discarding local edits and adopting the remote file. */
  adoptRemote(contents: string, revision: string): void {
    if (this.disposed) return;
    this.clearTimer();
    this.seed(revision, contents);
  }

  /**
   * Resolve a conflict by writing the buffered contents over the freshly read
   * remote revision — a deliberate user overwrite, never automatic.
   */
  forcePersist(remoteRevision: string): void {
    if (this.disposed) return;
    this.baseRevision = remoteRevision;
    this.conflicted = false;
    void this.persistLatest();
    this.notify();
  }

  /** Retry a failed persist (error state with pending edits). */
  retry(): void {
    if (this.disposed || this.saving || !this.pending || this.conflicted) return;
    void this.persistLatest();
  }

  /** Native unmount semantics: pending edits flush immediately. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    if (this.latestRevision > 0 && !this.conflicted) void this.persistLatest();
  }

  /** Abandon the session without flushing — cancels any pending debounce. */
  cancel(): void {
    this.disposed = true;
    this.clearTimer();
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

    this.saving = true;
    this.notify();
    const contents = this.latestContents;
    const revision = this.latestRevision;
    const outcome = await this.options.persist(contents, this.baseRevision);
    if (outcome.kind === "saved") {
      this.confirmedRevision = revision;
      this.baseRevision = outcome.revision;
      this.lastError = null;
      this.options.onConfirmed?.(contents, outcome.revision);
    } else if (outcome.kind === "conflict") {
      // A stale base means the file changed under us: stop autosaving and
      // surface it. Pending edits stay buffered for an explicit resolution.
      this.conflicted = true;
      this.clearTimer();
    } else {
      this.lastError = outcome.message;
    }

    this.saving = false;
    if (revision === this.latestRevision || this.conflicted) {
      this.notify();
      return;
    }

    const remainingDebounce = Math.max(0, this.options.debounceMs - (this.now - this.lastChangeAt));
    if (this.disposed) {
      void this.persistLatest();
    } else {
      this.schedule(remainingDebounce);
    }
    this.notify();
  }
}

export const FILE_SAVE_DEBOUNCE_MS = 500;
