import { realpathSync } from "node:fs";
import path from "node:path";
import {
  DependencyWatcher,
  type DependencyChangeListener,
  type DependencyWatcherOptions,
} from "./dependency-watcher.ts";

export interface BunImportTrackerOptions extends DependencyWatcherOptions {
  /**
   * Directory whose modules belong to the tracked graph. Files outside it and
   * anything under a `node_modules` directory load untouched.
   */
  readonly root: string;
}

const loaders: Record<string, "js" | "jsx" | "ts" | "tsx"> = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
};

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Records every project-local module Bun loads after registration and watches
 * those files for changes.
 *
 * Bun has no loader hooks that can evict or re-namespace an evaluated module,
 * so unlike Node's {@link ImportWatcher} this cannot import a fresh
 * generation in-process. A runtime `Bun.plugin` `onLoad` hook is used purely
 * as a dependency probe: it hands the source back unchanged with the loader
 * Bun would have picked itself. Callers react to a change by exiting so a
 * supervisor can start a fresh process.
 */
export class BunImportTracker {
  readonly #watcher: DependencyWatcher;
  readonly #dependencies = new Set<string>();

  constructor(options: BunImportTrackerOptions) {
    if (process.versions.bun === undefined) {
      throw new Error(
        "BunImportTracker requires Bun; Node callers should use watchImport.",
      );
    }
    this.#watcher = new DependencyWatcher(options);
    // Bun reports real paths (`/private/tmp/...` for `/tmp/...` on macOS);
    // match them against the root's real path too.
    const root = realpathSync.native(path.resolve(options.root)) + path.sep;
    const nodeModules = `${path.sep}node_modules${path.sep}`;
    const filter = new RegExp(
      `^${escapeRegExp(root)}(?!.*${escapeRegExp(nodeModules)}).*\\.[cm]?[jt]sx?$`,
    );
    Bun.plugin({
      name: "@alchemy.run/node-utils/watch-import-bun",
      setup: (build) => {
        build.onLoad({ filter }, async (args) => {
          this.#dependencies.add(args.path);
          this.#watcher.set(new Set(this.#dependencies));
          return {
            contents: await Bun.file(args.path).text(),
            loader: loaders[path.extname(args.path)] ?? "js",
          };
        });
      },
    });
  }

  get dependencies(): ReadonlySet<string> {
    return this.#watcher.dependencies;
  }

  subscribe(listener: DependencyChangeListener): () => void {
    return this.#watcher.subscribe(listener);
  }

  /** Stops watching. The load hook stays registered but only echoes sources. */
  close(): Promise<void> {
    return this.#watcher.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export const trackBunImports = (options: BunImportTrackerOptions) =>
  new BunImportTracker(options);
