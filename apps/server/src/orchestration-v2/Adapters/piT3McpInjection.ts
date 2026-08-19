import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";
import {
  PI_T3_MCP_EXTENSION_FILENAME,
  PI_T3_MCP_EXTENSION_SOURCE,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
} from "./piT3McpExtensionSource.ts";
import {
  PI_T3_SUBAGENT_EXTENSION_FILENAME,
  PI_T3_SUBAGENT_EXTENSION_SOURCE,
  T3_PI_CHILD_SESSION_ROOT_ENV,
} from "./piT3SubagentExtensionSource.ts";

export {
  PI_T3_MCP_EXTENSION_FILENAME,
  PI_T3_SUBAGENT_EXTENSION_FILENAME,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
  T3_PI_CHILD_SESSION_ROOT_ENV,
};

/** Env var telling the T3 subagent override where the MCP extension lives. */
export const T3_PI_MCP_EXTENSION_PATH_ENV = "T3_PI_MCP_EXTENSION_PATH";

function bearerTokenFromAuthorizationHeader(header: string): string {
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

const PiPackageSource = Schema.Union([
  Schema.String,
  Schema.Struct({
    source: Schema.String,
    autoload: Schema.optional(Schema.Boolean),
    extensions: Schema.optional(Schema.Array(Schema.String)),
  }),
]);

const PiSettingsFile = Schema.Struct({
  defaultProjectTrust: Schema.optional(Schema.String),
  packages: Schema.optional(Schema.Array(PiPackageSource)),
});

const PiPackageJson = Schema.Struct({
  pi: Schema.optional(
    Schema.Struct({
      extensions: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});

const PiTrustStore = Schema.Record(Schema.String, Schema.NullOr(Schema.Boolean));

const decodePiSettings = Schema.decodeUnknownOption(Schema.fromJsonString(PiSettingsFile));
const decodePiPackageJson = Schema.decodeUnknownOption(Schema.fromJsonString(PiPackageJson));
const decodePiTrustStore = Schema.decodeUnknownOption(Schema.fromJsonString(PiTrustStore));

function normalizePiTrustPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.length === 0) return "/";
  return /^[A-Za-z]:$/.test(normalized) ? `${normalized}/` : normalized;
}

function piTrustParentPath(value: string): string | undefined {
  if (value === "/" || /^[A-Za-z]:\/$/.test(value)) return undefined;
  const uncRoot = value.match(/^\/\/[^/]+\/[^/]+/)?.[0];
  if (uncRoot === value) return undefined;
  const separatorIndex = value.lastIndexOf("/");
  if (separatorIndex < 0) return undefined;
  const parent = separatorIndex === 0 ? "/" : value.slice(0, separatorIndex);
  return uncRoot !== undefined && parent.length < uncRoot.length
    ? uncRoot
    : normalizePiTrustPath(parent);
}

/** Mirrors Pi's canonical nearest-ancestor lookup over `trust.json`. */
function piNearestProjectTrustDecision(
  trust: typeof PiTrustStore.Type,
  cwd: string,
): boolean | undefined {
  const decisions = new Map(
    Object.entries(trust).map(([path, decision]) => [normalizePiTrustPath(path), decision]),
  );
  let current: string | undefined = normalizePiTrustPath(cwd);
  while (current !== undefined) {
    const decision = decisions.get(current);
    if (decision === true || decision === false) return decision;
    current = piTrustParentPath(current);
  }
  return undefined;
}

function piNpmPackageName(source: string): string | undefined {
  if (!source.startsWith("npm:")) return undefined;
  const spec = source.slice("npm:".length).trim();
  const name = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/)?.[1];
  return name !== undefined &&
    /^(?:@[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+|[A-Za-z0-9._~-]+)$/.test(name)
    ? name
    : undefined;
}

function piPackageSource(pkg: typeof PiPackageSource.Type): string {
  return typeof pkg === "string" ? pkg : pkg.source;
}

function piPackageExtensionPath(packageRoot: string, entry: string): string | undefined {
  const segments: Array<string> = [];
  for (const segment of entry.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.pop() === undefined) return undefined;
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? undefined : `${packageRoot}/${segments.join("/")}`;
}

function piPackagePatternPaths(
  fs: FileSystem.FileSystem,
  packageRoot: string,
  pattern: string,
  exact: boolean,
): Effect.Effect<Set<string>> {
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    normalizedPattern.length === 0 ||
    normalizedPattern.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalizedPattern) ||
    normalizedPattern.split("/").includes("..")
  ) {
    return Effect.succeed(new Set());
  }
  const patterns =
    exact || normalizedPattern.includes("/")
      ? [normalizedPattern]
      : [normalizedPattern, `**/${normalizedPattern}`];
  return Effect.forEach(patterns, (candidate) =>
    exact
      ? Effect.succeed([candidate])
      : fs.glob(candidate, { root: packageRoot }).pipe(Effect.orElseSucceed(() => [])),
  ).pipe(
    Effect.map(
      (groups) =>
        new Set(
          groups.flatMap((matches) =>
            matches.flatMap((match) => {
              const normalizedMatch = normalizePiPath(match);
              const path = normalizedMatch.startsWith(`${normalizePiPath(packageRoot)}/`)
                ? normalizedMatch
                : piPackageExtensionPath(packageRoot, normalizedMatch);
              return path === undefined ? [] : [path];
            }),
          ),
        ),
    ),
  );
}

function piEnabledPackageExtensions(
  fs: FileSystem.FileSystem,
  packageRoot: string,
  extensionPaths: ReadonlyArray<string>,
  pkg: typeof PiPackageSource.Type,
): Effect.Effect<Array<string>> {
  return Effect.gen(function* () {
    if (typeof pkg === "string") return [...extensionPaths];
    if (pkg.extensions === undefined) return pkg.autoload === false ? [] : [...extensionPaths];
    if (pkg.extensions.length === 0) return [];
    const includes = pkg.extensions.filter((pattern) => !/^[!+-]/.test(pattern));
    const patterns =
      pkg.autoload === false
        ? pkg.extensions
        : [
            ...includes,
            ...pkg.extensions.filter((pattern) => pattern.startsWith("!")),
            ...pkg.extensions.filter((pattern) => pattern.startsWith("+")),
            ...pkg.extensions.filter((pattern) => pattern.startsWith("-")),
          ];
    const enabled = new Set(pkg.autoload === false || includes.length > 0 ? [] : extensionPaths);
    for (const pattern of patterns) {
      const prefix = pattern[0];
      const target = /^[!+-]/.test(prefix ?? "") ? pattern.slice(1) : pattern;
      const matches = yield* piPackagePatternPaths(
        fs,
        packageRoot,
        target,
        prefix === "+" || prefix === "-",
      );
      for (const path of extensionPaths) {
        if (!matches.has(path)) continue;
        if (prefix === "!" || prefix === "-") enabled.delete(path);
        else enabled.add(path);
      }
    }
    return extensionPaths.filter((path) => enabled.has(path));
  });
}

/**
 * Re-discover the user's pi extensions for a `--no-extensions` spawn: the
 * subagent override forces discovery off (a second `subagent` registration
 * aborts pi), which must not cost the user every other extension they have.
 * Mirrors pi's own discovery roots and user npm package manifests:
 * `<agent dir>/extensions`, `settings.json` package `pi.extensions`, and the
 * project-local `.pi/extensions` only under Pi's recorded per-project trust
 * or, when no decision exists, `defaultProjectTrust: "always"` —
 * explicit `--extension` paths bypass pi's trust prompt, so anything short
 * of standing trust must not be silently loaded. Pi's `pi-subagents` package
 * and conventional `subagent` entries are skipped in favor of the T3 override.
 */
export const discoverPiUserExtensions = Effect.fn("discoverPiUserExtensions")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const home = input.environment["HOME"] ?? input.environment["USERPROFILE"];
  const agentDir =
    input.environment["PI_CODING_AGENT_DIR"] ??
    (home === undefined ? undefined : `${normalizePiPath(home)}/.pi/agent`);
  const normalizedAgentDir = agentDir === undefined ? undefined : normalizePiPath(agentDir);
  const settingsRaw =
    normalizedAgentDir === undefined
      ? ""
      : yield* fs
          .readFileString(`${normalizedAgentDir}/settings.json`)
          .pipe(Effect.orElseSucceed(() => ""));
  const settings = Option.getOrUndefined(decodePiSettings(settingsRaw));
  const roots: Array<string> = [];
  if (normalizedAgentDir !== undefined) roots.push(`${normalizedAgentDir}/extensions`);
  if (normalizedAgentDir !== undefined && input.cwd !== undefined) {
    const cwd = input.cwd;
    const trustPath = `${normalizedAgentDir}/trust.json`;
    const trustExists = yield* fs.exists(trustPath).pipe(Effect.orElseSucceed(() => false));
    const trustRaw = trustExists
      ? yield* fs.readFileString(trustPath).pipe(Effect.orElseSucceed(() => ""))
      : undefined;
    const trustStore =
      trustRaw === undefined ? {} : Option.getOrUndefined(decodePiTrustStore(trustRaw));
    const canonicalCwd = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    const decision =
      trustStore === undefined ? false : piNearestProjectTrustDecision(trustStore, canonicalCwd);
    const projectTrusted = decision ?? settings?.defaultProjectTrust === "always";
    if (projectTrusted) {
      roots.push(`${normalizePiPath(cwd)}/.pi/extensions`);
    }
  }
  const found: Array<string> = [];
  const addFound = (path: string) => {
    if (!isConflictingPiSubagentExtensionPath(path) && !found.includes(path)) found.push(path);
  };
  for (const root of roots) {
    const entries = yield* fs
      .readDirectory(root)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    for (const entry of entries.toSorted()) {
      if (entry === "subagent" || entry === "subagent.ts" || entry === "subagent.js") continue;
      const path = `${root}/${entry}`;
      if (entry.endsWith(".ts") || entry.endsWith(".js")) {
        addFound(path);
        continue;
      }
      for (const indexPath of [`${path}/index.ts`, `${path}/index.js`]) {
        const hasIndex = yield* fs.exists(indexPath).pipe(Effect.orElseSucceed(() => false));
        if (hasIndex) {
          addFound(indexPath);
          break;
        }
      }
    }
  }
  if (normalizedAgentDir !== undefined) {
    for (const pkg of settings?.packages ?? []) {
      const packageName = piNpmPackageName(piPackageSource(pkg));
      if (packageName === undefined || packageName === "pi-subagents") continue;
      const packageRoot = `${normalizedAgentDir}/npm/node_modules/${packageName}`;
      const packageJsonRaw = yield* fs
        .readFileString(`${packageRoot}/package.json`)
        .pipe(Effect.orElseSucceed(() => ""));
      const packageJson = Option.getOrUndefined(decodePiPackageJson(packageJsonRaw));
      const extensionPaths: Array<string> = [];
      for (const entry of packageJson?.pi?.extensions ?? []) {
        const extensionPath = piPackageExtensionPath(packageRoot, entry);
        if (extensionPath === undefined) continue;
        const exists = yield* fs.exists(extensionPath).pipe(Effect.orElseSucceed(() => false));
        if (exists) extensionPaths.push(extensionPath);
      }
      const enabledExtensions = yield* piEnabledPackageExtensions(
        fs,
        packageRoot,
        extensionPaths,
        pkg,
      );
      for (const extensionPath of enabledExtensions) {
        addFound(extensionPath);
      }
    }
  }
  return found;
});

function piT3McpExtensionDestPath(cacheDir: string): string {
  return `${cacheDir.replace(/\\/g, "/")}/${PI_T3_MCP_EXTENSION_FILENAME}`;
}

function piT3SubagentExtensionDestPath(cacheDir: string): string {
  return `${cacheDir.replace(/\\/g, "/")}/${PI_T3_SUBAGENT_EXTENSION_FILENAME}`;
}

function piChildSessionRootFromLaunchArgs(launchArgs: string): string | undefined {
  const args = tokenizeCliArgs(launchArgs);
  const index = args.indexOf("--session-dir");
  const sessionDir = index >= 0 ? args[index + 1] : undefined;
  if (sessionDir === undefined || sessionDir.length === 0) return undefined;
  return `${sessionDir.replace(/\\/g, "/")}/children`;
}

export const materializePiT3McpExtension = Effect.fn("materializePiT3McpExtension")(function* (
  cacheDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  const dest = piT3McpExtensionDestPath(cacheDir);
  const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
  if (existing !== PI_T3_MCP_EXTENSION_SOURCE) {
    yield* fs.writeFileString(dest, PI_T3_MCP_EXTENSION_SOURCE);
  }
  return dest;
});

export const materializePiT3SubagentExtension = Effect.fn("materializePiT3SubagentExtension")(
  function* (cacheDir: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(cacheDir, { recursive: true });
    const dest = piT3SubagentExtensionDestPath(cacheDir);
    const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
    if (existing !== PI_T3_SUBAGENT_EXTENSION_SOURCE) {
      yield* fs.writeFileString(dest, PI_T3_SUBAGENT_EXTENSION_SOURCE);
    }
    return dest;
  },
);

function appendExtensionArg(
  args: ReadonlyArray<string>,
  extensionPath: string | undefined,
): string[] {
  return extensionPath === undefined ? [...args] : [...args, "--extension", extensionPath];
}

function normalizePiPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Official / user-installed `subagent` tool. Not the T3 override file. */
function isConflictingPiSubagentExtensionPath(extensionPath: string): boolean {
  const normalized = normalizePiPath(extensionPath);
  if (normalized.endsWith(`/${PI_T3_SUBAGENT_EXTENSION_FILENAME}`)) return false;
  return (
    normalized.endsWith("/extensions/subagent/index.ts") ||
    normalized.endsWith("/extensions/subagent/index.js") ||
    normalized.endsWith("/examples/extensions/subagent/index.ts") ||
    normalized.endsWith("/examples/extensions/subagent/index.js")
  );
}

function stripConflictingPiSubagentExtensionArgs(args: ReadonlyArray<string>): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const next = args[index + 1];
    if (
      (arg === "--extension" || arg === "-e") &&
      next !== undefined &&
      isConflictingPiSubagentExtensionPath(next)
    ) {
      index += 1;
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

function deduplicatePiExtensionArgs(args: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const deduplicated: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const extensionPath = args[index + 1];
    if ((arg === "--extension" || arg === "-e") && extensionPath !== undefined) {
      index += 1;
      const normalized = normalizePiPath(extensionPath);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      deduplicated.push(arg, extensionPath);
      continue;
    }
    deduplicated.push(arg);
  }
  return deduplicated;
}

export function buildPiRpcLaunch(input: {
  readonly launchArgs: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpSession: McpProviderSessionConfig | undefined;
  readonly extensionPath: string | undefined;
  readonly subagentExtensionPath?: string | undefined;
  /** User extensions re-added around the `--no-extensions` subagent spawn. */
  readonly discoveredExtensionPaths?: ReadonlyArray<string> | undefined;
}): {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly hasT3Mcp: boolean;
} {
  const userArgs = tokenizeCliArgs(input.launchArgs);
  const hasT3Mcp = input.mcpSession !== undefined && input.extensionPath !== undefined;
  // Duplicate `subagent` registrations abort Pi. Disable discovery and drop
  // the official tool from launchArgs so only the T3 override remains.
  let args = ["--mode", "rpc"];
  if (input.subagentExtensionPath !== undefined) {
    if (!userArgs.includes("--no-extensions") && !userArgs.includes("-ne")) {
      args.push("--no-extensions");
    }
    args = appendExtensionArg(args, input.subagentExtensionPath);
    for (const discovered of input.discoveredExtensionPaths ?? []) {
      args = appendExtensionArg(args, discovered);
    }
    args = [...args, ...stripConflictingPiSubagentExtensionArgs(userArgs)];
  } else {
    args = [...args, ...userArgs];
  }
  if (hasT3Mcp && input.extensionPath !== undefined) {
    args = appendExtensionArg(args, input.extensionPath);
  }
  args = deduplicatePiExtensionArgs(args);

  const childSessionRoot = piChildSessionRootFromLaunchArgs(input.launchArgs);
  return {
    args,
    env: {
      ...input.environment,
      ...(input.subagentExtensionPath === undefined || childSessionRoot === undefined
        ? {}
        : { [T3_PI_CHILD_SESSION_ROOT_ENV]: childSessionRoot }),
      ...(hasT3Mcp && input.mcpSession !== undefined
        ? {
            [T3_MCP_URL_ENV]: input.mcpSession.endpoint,
            [T3_MCP_BEARER_ENV]: bearerTokenFromAuthorizationHeader(
              input.mcpSession.authorizationHeader,
            ),
            // The subagent override passes this through to child spawns so
            // native children get the T3 tools too (env is inherited).
            ...(input.extensionPath === undefined
              ? {}
              : { [T3_PI_MCP_EXTENSION_PATH_ENV]: input.extensionPath }),
          }
        : {}),
    },
    hasT3Mcp,
  };
}
