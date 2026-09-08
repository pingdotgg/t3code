import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as NodeCrypto from "node:crypto";

/**
 * A single server module produced by a framework build.
 *
 * `name` is the module path relative to the build's `distDirectory`
 * (e.g. `server/index.js`). Binary content is normalized to `Buffer` so it
 * survives a JSON round-trip through `dist/build.json`.
 */
export interface OutputFile {
  name: string;
  content: string | Uint8Array;
  hash: string;
}

/**
 * The framework-integration build contract.
 *
 * Every framework integration (Vite, Waku, Astro, SvelteKit, Next.js, ...)
 * produces this shape:
 *
 * - `clientDirectory` — the static-assets directory, captured as a path so
 *   files written after the bundler finishes (SSG HTML, prerendered pages)
 *   ride along.
 * - `serverModules` — the worker modules, **entry first**, each with a sha256
 *   content hash. `undefined` for assets-only builds.
 * - `externalWorkspaces` — workspace roots (directories containing a
 *   `package.json`) of modules imported from outside the project root, used
 *   for watch/memoization.
 */
export interface BuildOutput {
  /** Root output directory of the build (e.g. `<root>/dist`). */
  distDirectory?: string | undefined;
  clientDirectory: string | undefined;
  serverModules: Array<OutputFile> | undefined;
  externalWorkspaces: Set<string>;
}

/** Create an {@link OutputFile}, hashing the content with sha256. */
export const toOutputFile = (
  name: string,
  content: string | Uint8Array,
): Effect.Effect<OutputFile> =>
  Effect.sync(() => ({
    name,
    // Normalize binary content to Buffer so JSON.stringify produces the
    // `{ type: "Buffer", data: [...] }` shape that readBuildOutput revives.
    content: typeof content === "string" ? content : Buffer.from(content),
    hash: NodeCrypto.createHash("sha256").update(content).digest("hex"),
  }));

/**
 * Sort server modules entry-first (the module named `entry` comes first, the
 * rest sorted lexicographically) — the order the `BuildOutput` contract
 * requires.
 */
export const sortServerModules = (
  modules: Array<OutputFile>,
  entry: string | undefined,
): Array<OutputFile> =>
  [...modules].sort((a, b) => {
    if (a.name === entry) return -1;
    if (b.name === entry) return 1;
    return a.name.localeCompare(b.name);
  });

/**
 * Serialize a {@link BuildOutput} for persistence (`dist/build.json`).
 * Sets are serialized as sorted arrays; binary content relies on Buffer's
 * `{ type: "Buffer", data }` JSON form.
 *
 * @internal harness plumbing (the e2e harness's persistence mechanism), not
 * part of the public framework-integration API.
 */
export const stringifyBuildOutput = (output: BuildOutput): string =>
  JSON.stringify(
    output,
    (_, value) =>
      value instanceof Set ? Array.from(value as Set<string>).sort() : value,
    2,
  );

/**
 * Parse a persisted {@link BuildOutput}, reviving `Buffer` content and the
 * `externalWorkspaces` Set (tolerating the legacy `{}` serialization).
 *
 * @internal harness plumbing (the e2e harness's persistence mechanism), not
 * part of the public framework-integration API.
 */
export const parseBuildOutput = (content: string): BuildOutput => {
  const parsed = JSON.parse(content, (_, value) => {
    if (
      Predicate.hasProperty(value, "type") &&
      value.type === "Buffer" &&
      Predicate.hasProperty(value, "data")
    ) {
      return Buffer.from(value.data as Array<number>);
    }
    return value;
  }) as BuildOutput & { externalWorkspaces: unknown };
  parsed.externalWorkspaces = new Set(
    Array.isArray(parsed.externalWorkspaces)
      ? (parsed.externalWorkspaces as Array<string>)
      : [],
  );
  return parsed as BuildOutput;
};

/**
 * Persist a {@link BuildOutput} to disk (conventionally `dist/build.json`,
 * so preview/serve flows stay uniform across frameworks).
 *
 * Creates the target's parent directory if it does not exist — with a nested
 * project root (e.g. `fixtures/x/app`) the framework writes its own output to
 * `app/dist`, so the harness-level `<cwd>/dist` may not exist yet.
 *
 * @internal harness plumbing (the e2e harness's persistence mechanism), not
 * part of the public framework-integration API.
 */
export const writeBuildOutput = (
  filePath: string,
  output: BuildOutput,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, stringifyBuildOutput(output));
  });

/**
 * Read a persisted {@link BuildOutput} from disk.
 *
 * @internal harness plumbing (the e2e harness's persistence mechanism), not
 * part of the public framework-integration API.
 */
export const readBuildOutput = (
  path: string,
): Effect.Effect<BuildOutput, PlatformError, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.map(fs.readFileString(path), parseBuildOutput),
  );
