import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import rolldown from "rolldown/package.json" with { type: "json" };
import self from "../../package.json" with { type: "json" };

/**
 * Anything that changes Oxc's output for identical input invalidates every
 * entry: the transformer itself (rolldown), this package's transform
 * pipeline, and the on-disk entry layout.
 */
const CACHE_VERSION = ["1", self.version, rolldown.version].join("-");

/** Entries untouched for this long are swept on the first disk access. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How often the sweep runs. Every process on the machine opens the cache,
 * and a sweep stats every entry — thousands of files — so a marker file's
 * mtime limits it to once per interval.
 */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SWEEP_MARKER = ".swept";

export const TRANSFORM_CACHE_ENV = "ALCHEMY_TRANSFORM_CACHE";

/**
 * Per-user directory, like tsx's `tsx-<uid>`: `tmpdir()` is shared on
 * multi-user machines, and entries are written with the owner's umask.
 */
const defaultDirectory = () => {
  const user = process.geteuid?.() ?? os.userInfo().username;
  return path.join(os.tmpdir(), `alchemy-oxc-${user}`);
};

/**
 * The directory to use for the given option, or `undefined` when caching is
 * off. `cache: false` and `ALCHEMY_TRANSFORM_CACHE=0` disable it; a string
 * (option or env) names the directory; otherwise the per-user default.
 */
export const resolveCacheDirectory = (option: boolean | string | undefined): string | undefined => {
  if (option === false) return undefined;
  if (typeof option === "string") return option;
  const env = process.env[TRANSFORM_CACHE_ENV];
  if (env === "0" || env === "false") return undefined;
  if (env !== undefined && env !== "") return env;
  return defaultDirectory();
};

/** One transform's output as handed to {@link TransformCache.set}. */
export interface TransformCacheEntry {
  readonly format: "module" | "commonjs";
  readonly code: string;
  /** Source map JSON, or `undefined` when the transform produced none. */
  readonly map: string | undefined;
}

/** A cache hit: the code, and where its source map lives on disk. */
export interface CachedTransform {
  readonly format: "module" | "commonjs";
  readonly code: string;
  /** Absolute path of the entry's `.map` file, present when it has one. */
  readonly mapFile: string | undefined;
}

/**
 * On-disk cache of Oxc transform output shared by every process on the
 * machine — the `alchemy` CLI, its dev exec child, the local-provider
 * sidecars and dev-server runners all load the same source files, and
 * without this each of them transpiles the whole graph again.
 *
 * Modelled on tsx's file cache: entries are keyed by a hash of the source
 * file's path, size and mtime, the transform options and the resolved
 * tsconfig, so a change to any input is simply a different key; nothing is
 * ever invalidated in place. Size plus nanosecond mtime stands in for the
 * contents so a hit never reads the source.
 *
 * An entry is two files: `<key>.code` with the code behind a short header,
 * and `<key>.map` with the source map. The map stays on disk and is referenced from the module
 * by path rather than inlined — an inline `data:` map is part of the
 * script's source text, which V8 keeps for the process lifetime; for a
 * graph the size of alchemy's that is hundreds of megabytes per process.
 * Node reads the referenced file synchronously as it compiles the module,
 * so the map is written (atomically) before `set` returns; the code entry
 * is a fire-and-forget write, because a missing one is only a slower
 * cache. Reads are synchronous (the loader hook is). Stale entries are
 * swept by age at most once a day.
 */
export class TransformCache {
  readonly #directory: string;
  #ready = false;
  #sequence = 0;

  constructor(directory: string) {
    this.#directory = directory;
  }

  /** The entry key for these transform inputs. */
  key(parts: ReadonlyArray<string>): string {
    const hash = createHash("sha1");
    hash.update(CACHE_VERSION);
    for (const part of parts) {
      // Length-prefixed so adjacent parts cannot run into each other.
      hash.update(`\0${part.length}\0`);
      hash.update(part);
    }
    return hash.digest("hex");
  }

  /**
   * The cached transform, or `undefined` on a miss. An entry whose map file
   * has gone (swept, or never landed) is a miss too: the module would
   * otherwise reference a map that is not there.
   */
  get(key: string): CachedTransform | undefined {
    this.#prepare();
    let raw: string;
    try {
      raw = readFileSync(this.#file(key, "code"), "utf8");
    } catch {
      return undefined;
    }
    // `<format><map>\n<code>`: the code is stored as is, so a hit is one
    // read and a slice rather than a JSON parse of the whole module.
    const format = raw[0] === "m" ? "module" : raw[0] === "c" ? "commonjs" : undefined;
    if (format === undefined || raw[2] !== "\n" || (raw[1] !== "1" && raw[1] !== "0")) {
      return undefined;
    }
    const mapFile = raw[1] === "1" ? this.#file(key, "map") : undefined;
    if (mapFile !== undefined && !existsSync(mapFile)) return undefined;
    return { format, code: raw.slice(3), mapFile };
  }

  /**
   * Stores one transform. Returns the map file's path once it is on disk,
   * or `undefined` when there is no map or it could not be written — the
   * caller then falls back to inlining it.
   */
  set(key: string, entry: TransformCacheEntry): string | undefined {
    this.#prepare();
    let mapFile: string | undefined;
    if (entry.map !== undefined) {
      mapFile = this.#file(key, "map");
      if (!this.#writeAtomically(mapFile, entry.map)) return undefined;
    }
    const file = this.#file(key, "code");
    const temporary = this.#temporary(file);
    const header = `${entry.format === "module" ? "m" : "c"}${mapFile === undefined ? "0" : "1"}\n`;
    // Best effort: a cache that cannot be written is only a slower cache.
    fs.writeFile(temporary, header + entry.code)
      .then(() => fs.rename(temporary, file))
      .catch(() => fs.unlink(temporary).catch(() => {}));
    return mapFile;
  }

  #file(key: string, extension: "code" | "map") {
    return path.join(this.#directory, `${key}.${extension}`);
  }

  #temporary(file: string) {
    return `${file}.${process.pid}.${this.#sequence++}.tmp`;
  }

  /** Temp file plus rename: concurrent readers never see a partial file. */
  #writeAtomically(file: string, content: string): boolean {
    const temporary = this.#temporary(file);
    try {
      writeFileSync(temporary, content);
      renameSync(temporary, file);
      return true;
    } catch {
      try {
        unlinkSync(temporary);
      } catch {}
      return false;
    }
  }

  #prepare() {
    if (this.#ready) return;
    this.#ready = true;
    try {
      mkdirSync(this.#directory, { recursive: true });
    } catch {
      return;
    }
    // Off the hot path: the loader hook that got us here is synchronous.
    setImmediate(() => {
      this.#sweep().catch(() => {});
    });
  }

  async #sweep() {
    const marker = path.join(this.#directory, SWEEP_MARKER);
    const swept = await fs.stat(marker).then(
      ({ mtimeMs }) => mtimeMs,
      () => 0,
    );
    if (Date.now() - swept < SWEEP_INTERVAL_MS) return;
    await fs.writeFile(marker, "");
    const cutoff = Date.now() - MAX_AGE_MS;
    const names = await fs.readdir(this.#directory);
    await Promise.all(
      names.map(async (name) => {
        if (name === SWEEP_MARKER) return;
        const file = path.join(this.#directory, name);
        try {
          const { mtimeMs } = await fs.stat(file);
          if (mtimeMs < cutoff) await fs.unlink(file);
        } catch {}
      }),
    );
  }
}
