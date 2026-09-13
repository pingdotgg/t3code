import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  DependencyWatcher,
  type DependencyChangeListener,
  type DependencyWatcherOptions,
} from "./dependency-watcher.ts";
import {
  createImportLoader,
  type ImportLoader,
  type ImportLoaderOptions,
} from "./import-loader.ts";

export interface ImportGeneration<T> {
  readonly value: T;
  readonly namespace: string;
  readonly dependencies: ReadonlySet<string>;
}

export interface ImportWatcherOptions
  extends ImportLoaderOptions, DependencyWatcherOptions {
  readonly parentURL: string;
}

/**
 * Imports fresh Node module generations and watches the exact files loaded by
 * the current generation. Bun callers should use `BunImportTracker` from
 * `./watch-import-bun.ts`: Bun cannot evict evaluated modules, so a change
 * there restarts the process instead of importing a new generation.
 */
export class ImportWatcher<T = unknown> {
  readonly #specifier: string;
  readonly #options: ImportWatcherOptions;
  readonly #watcher: DependencyWatcher;
  #registration: ImportLoader | undefined;
  #dependencies = new Set<string>();
  #closed = false;

  constructor(specifier: string, options: ImportWatcherOptions) {
    this.#specifier = specifier;
    this.#options = options;
    this.#watcher = new DependencyWatcher(options);
  }

  get dependencies(): ReadonlySet<string> {
    return this.#dependencies;
  }

  subscribe(listener: DependencyChangeListener): () => void {
    return this.#watcher.subscribe(listener);
  }

  async import(): Promise<ImportGeneration<T>> {
    if (this.#closed) throw new Error("ImportWatcher is closed");
    const namespace = randomUUID();
    const dependencies = new Set<string>();
    const {
      debounceMs: _,
      parentURL,
      watch: _watch,
      ...registerOptions
    } = this.#options;
    const registration = await createImportLoader({
      ...registerOptions,
      namespace,
      onImport: (url) => {
        if (!url.startsWith("file:")) return;
        dependencies.add(fileURLToPath(url));
        // A lazy import evaluated after this generation became current
        // extends the watched set immediately.
        if (this.#dependencies === dependencies)
          this.#watcher.set(dependencies);
      },
    });
    try {
      const value = await registration.import<T>(this.#specifier, parentURL);
      await this.#registration?.unregister();
      this.#registration = registration;
      this.#dependencies = dependencies;
      this.#watcher.set(dependencies);
      return { value, namespace, dependencies };
    } catch (error) {
      await registration.unregister();
      // Keep watching everything the failed import touched so the next save
      // of any of those files retries.
      this.#dependencies = new Set([...this.#dependencies, ...dependencies]);
      this.#watcher.set(this.#dependencies);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#registration?.unregister();
    await this.#watcher.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export const watchImport = <T = unknown>(
  specifier: string,
  options: ImportWatcherOptions,
) => new ImportWatcher<T>(specifier, options);
