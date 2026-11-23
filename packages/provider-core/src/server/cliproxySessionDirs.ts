import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { expandHomePath } from "./pathExpansion.ts";

/**
 * CLIProxyAPI deployments can keep provider homes inside the proxy's data directory, which moves
 * session transcripts out of the providers' default locations. Usage readers therefore also look
 * for provider-shaped session directories under the proxy data dir, so sessions keep counting no
 * matter which home a proxied account used.
 */
const CLIPROXY_DIR_ENV_NAMES = [
  "CLIPROXY_API_AUTH_DIR",
  "CLIPROXY_AUTH_DIR",
  "CLIPROXY_HOME",
] as const;
const DEFAULT_CLIPROXY_DIR_NAME = ".cli-proxy-api";

/** Deepest nesting allowed between a CLIProxyAPI data dir and a provider session dir. */
const MAX_LEAF_DEPTH = 4;
/** Deepest nesting inside a session dir when probing for a confirming transcript file. */
const DEFAULT_FILE_PROBE_DEPTH = 4;

/** CLIProxyAPI data dirs that may hold provider homes: env overrides first, then the default. */
const cliproxyDataDirs = Effect.fn("cliproxySessionDirs.cliproxyDataDirs")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const processEnvironment = yield* HostProcess.Environment;
  const fileSystem = yield* FileSystem.FileSystem;
  const candidates = [
    ...CLIPROXY_DIR_ENV_NAMES.map(
      (name) => environment[name]?.trim() || processEnvironment[name]?.trim() || "",
    ),
    path.join(home, DEFAULT_CLIPROXY_DIR_NAME),
  ];
  const seen = new Set<string>();
  const roots: Array<string> = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const dir = path.resolve(expandHomePath(candidate, home));
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (yield* isDirectory(fileSystem, dir)) roots.push(dir);
  }
  return roots;
});

const isDirectory = (fileSystem: FileSystem.FileSystem, dir: string) =>
  fileSystem.stat(dir).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );

/** Whether `dir` holds a file matching `filePattern` within `probeDepth` directory levels. */
const containsMatchingFile = Effect.fn("cliproxySessionDirs.containsMatchingFile")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  dir: string,
  filePattern: RegExp,
  probeDepth: number,
) {
  const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  while (stack.length > 0) {
    const { dir: current, depth } = stack.pop()!;
    const entries = yield* fileSystem
      .readDirectory(current)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    for (const name of entries) {
      const child = path.join(current, name);
      const info = yield* fileSystem.stat(child).pipe(Effect.orElseSucceed(() => null));
      if (info === null) continue;
      if (info.type === "Directory") {
        if (depth < probeDepth) stack.push({ dir: child, depth: depth + 1 });
      } else if (filePattern.test(name)) {
        return true;
      }
    }
  }
  return false;
});

/** Provider session dirs under a CLIProxyAPI data dir; `fileProbeDepth: 0` keeps flat-file
 * providers from claiming another provider's same-named leaf directory. */
export const discoverCliproxySessionDirs = Effect.fn(
  "cliproxySessionDirs.discoverCliproxySessionDirs",
)(function* (options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly leafName: string;
  readonly filePattern: RegExp;
  readonly fileProbeDepth?: number;
  readonly exclude?: ReadonlyArray<string>;
}) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const probeDepth = options.fileProbeDepth ?? DEFAULT_FILE_PROBE_DEPTH;
  const excluded = new Set((options.exclude ?? []).map((dir) => path.resolve(dir)));
  const seen = new Set<string>();
  const found: Array<string> = [];
  for (const root of yield* cliproxyDataDirs(options.environment)) {
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (stack.length > 0) {
      const { dir: current, depth } = stack.pop()!;
      const entries = yield* fileSystem
        .readDirectory(current)
        .pipe(Effect.orElseSucceed(() => [] as Array<string>));
      for (const name of entries) {
        const child = path.join(current, name);
        if (!(yield* isDirectory(fileSystem, child))) continue;
        if (name === options.leafName) {
          const matches =
            !seen.has(child) &&
            !excluded.has(child) &&
            (yield* containsMatchingFile(fileSystem, path, child, options.filePattern, probeDepth));
          if (matches) {
            seen.add(child);
            found.push(child);
          }
          continue;
        }
        if (name === "node_modules" || name === ".git") continue;
        if (depth < MAX_LEAF_DEPTH) stack.push({ dir: child, depth: depth + 1 });
      }
    }
  }
  return found;
});
