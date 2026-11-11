import { randomUUID } from "node:crypto";
// A namespace import: Bun has no `registerHooks`, and a named import of a
// missing builtin export is a SyntaxError at load time, not at call time.
import * as NodeModule from "node:module";
import { fileURLToPath } from "node:url";
import type { LoaderOptions } from "../loader/hooks.ts";
import type { NamespaceOptions } from "../loader/namespace.ts";
import { DependencyWatcher, type DependencyWatcherOptions } from "./dependency-watcher.ts";

export interface ImportGeneration<T> {
  readonly value: T;
  readonly namespace: string;
  readonly dependencies: ReadonlySet<string>;
}

export interface ImportWatcherOptions
  extends LoaderOptions, DependencyWatcherOptions, Pick<NamespaceOptions, "shouldInvalidate"> {
  readonly parentURL: string;
}

/**
 * Imports fresh generations of one module graph and watches exactly the
 * files the current generation loaded. Each generation registers the Oxc
 * loader hooks under a new namespace (see ../loader/namespace.ts), so Node
 * evaluates the same files again as new modules; the previous generation's
 * hooks are deregistered once the new one is in.
 *
 * CommonJS members of the graph live in Node's path-keyed `require` cache,
 * which no namespace reaches; a new generation evicts the previous one's
 * files from it so they are evaluated again too.
 *
 * Bun callers use `BunImportTracker` (./bun-import-tracker.ts): Bun cannot
 * evict evaluated modules, so a change there restarts the process instead.
 */
export class ImportWatcher<T = unknown> extends DependencyWatcher {
  readonly #specifier: string;
  readonly #options: ImportWatcherOptions;
  readonly #require = NodeModule.createRequire(import.meta.url);
  #registration: ReturnType<typeof NodeModule.registerHooks> | undefined;
  #releaseSourceMaps: (() => void) | undefined;
  #closed = false;

  constructor(specifier: string, options: ImportWatcherOptions) {
    super(options);
    this.#specifier = specifier;
    this.#options = options;
  }

  async import(): Promise<ImportGeneration<T>> {
    if (this.#closed) throw new Error("ImportWatcher is closed");
    // Loaded here, not at module scope: the exec child imports this file on
    // both runtimes, and the loader's Node hooks do not exist under Bun.
    const [{ createHooks }, { importNamespaced, namespaced }, { leaseSourceMapSupport }] =
      await Promise.all([
        import("../loader/hooks.ts"),
        import("../loader/namespace.ts"),
        import("../loader/source-map.ts"),
      ]);
    this.#releaseSourceMaps ??= leaseSourceMapSupport();
    for (const file of this.dependencies) delete this.#require.cache[file];
    const namespace = randomUUID();
    const dependencies = new Set<string>();
    let current = false;
    const registration = NodeModule.registerHooks(
      namespaced(createHooks(this.#options), {
        namespace,
        shouldInvalidate: this.#options.shouldInvalidate,
        onImport: (url) => {
          dependencies.add(fileURLToPath(url));
          // A lazy import evaluated after this generation became current
          // extends the watched set immediately.
          if (current) this.set(new Set(dependencies));
        },
      }),
    );
    try {
      const value = await importNamespaced<T>(this.#specifier, this.#options.parentURL, namespace);
      this.#registration?.deregister();
      this.#registration = registration;
      current = true;
      this.set(new Set(dependencies));
      return { value, namespace, dependencies };
    } catch (error) {
      registration.deregister();
      // Keep watching everything the failed import touched so the next save
      // of any of those files retries.
      this.set(new Set([...this.dependencies, ...dependencies]));
      throw error;
    }
  }

  override async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#registration?.deregister();
    this.#releaseSourceMaps?.();
    await super.close();
  }
}

export const watchImport = <T = unknown>(specifier: string, options: ImportWatcherOptions) =>
  new ImportWatcher<T>(specifier, options);
