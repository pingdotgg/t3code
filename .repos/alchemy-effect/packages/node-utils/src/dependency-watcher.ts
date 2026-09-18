import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { watch, type ChokidarOptions, type FSWatcher } from "chokidar";

export interface DependencyChange {
  readonly paths: ReadonlySet<string>;
}

export type DependencyChangeListener = (change: DependencyChange) => void;

export interface DependencyWatcherOptions {
  /** Chokidar options passed to the file watcher. */
  readonly watch?: ChokidarOptions | undefined;
  readonly debounceMs?: number | undefined;
}

/**
 * Watches an explicit set of absolute file paths and delivers debounced
 * batches only when their contents change. Chokidar follows editor atomic-save
 * replacements without polling by default. The set is replaced wholesale
 * with {@link set}, so the watcher always mirrors exactly the files the caller
 * currently depends on.
 */
export class DependencyWatcher {
  readonly #options: DependencyWatcherOptions;
  readonly #listeners = new Set<DependencyChangeListener>();
  readonly #watcher: FSWatcher;
  #dependencies: ReadonlySet<string> = new Set();
  #fingerprints = new Map<string, string | undefined>();
  #pending = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: DependencyWatcherOptions = {}) {
    this.#options = options;
    this.#watcher = watch([], {
      ...options.watch,
      ignoreInitial: true,
    });
    this.#watcher.on("all", (_event, changed) => {
      const absolute = path.resolve(this.#cwd(), changed);
      if (this.#dependencies.has(absolute)) this.#queue(absolute);
    });
  }

  get dependencies(): ReadonlySet<string> {
    return this.#dependencies;
  }

  subscribe(listener: DependencyChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Replace the watched set with `dependencies` (absolute paths). */
  set(dependencies: ReadonlySet<string>): void {
    if (this.#closed) return;
    const previous = this.#dependencies;
    this.#dependencies = dependencies;
    const removed = [...previous].filter(
      (dependency) => !dependencies.has(dependency),
    );
    const added = [...dependencies].filter(
      (dependency) => !previous.has(dependency),
    );
    if (removed.length > 0) {
      for (const dependency of removed) {
        this.#fingerprints.delete(dependency);
        this.#pending.delete(dependency);
      }
      void this.#watcher.unwatch(removed);
    }
    if (added.length > 0) {
      for (const dependency of added) {
        this.#fingerprints.set(dependency, this.#fingerprint(dependency));
      }
      this.#watcher.add(added);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    await this.#watcher.close();
    this.#listeners.clear();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #cwd(): string {
    return this.#options.watch?.cwd ?? process.cwd();
  }

  #queue(changed: string): void {
    this.#pending.add(changed);
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const pending = this.#pending;
      this.#pending = new Set();
      const paths = new Set<string>();
      for (const dependency of pending) {
        const previous = this.#fingerprints.get(dependency);
        const current = this.#fingerprint(dependency);
        if (current === previous) continue;
        this.#fingerprints.set(dependency, current);
        paths.add(dependency);
      }
      if (paths.size === 0) return;
      for (const listener of this.#listeners) listener({ paths });
    }, this.#options.debounceMs ?? 50);
  }

  #fingerprint(file: string): string | undefined {
    try {
      return createHash("sha256")
        .update(readFileSync(file))
        .digest("base64url");
    } catch {
      // Missing and unreadable are both materially different from the last
      // successfully read contents, while repeated missing-file events fold
      // onto the same value.
      return undefined;
    }
  }
}
