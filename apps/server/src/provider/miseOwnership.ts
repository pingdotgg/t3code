import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { runInstallerProbe } from "./installerProbe.ts";
import type { ProviderMaintenanceResolutionContext } from "./providerMaintenance.ts";

const MISE_PROBE_TIMEOUT = Duration.seconds(10);
// `outdated` asks each backend's registry for new versions.
const MISE_OUTDATED_TIMEOUT = Duration.seconds(30);
// `ls` prints every installed version of every tool.
const MISE_PROBE_MAX_BYTES = 4 * 1_024 * 1_024;
const LAUNCHER_SCRIPT_MAX_BYTES = 8_192;
const SYMLINK_HOPS_MAX = 40;

export type MiseOwnership =
  /** Nothing ties the executable to mise; the other installers decide. */
  | { readonly kind: "unrelated" }
  /** Mise's Node runs a package that its own npm installed globally; npm owns it. */
  | {
      readonly kind: "npm-global";
      readonly resolvedCommandPath: string;
      readonly realCommandPath: string;
      /**
       * The Node install mise reported for an aliased Node such as `node-lts`;
       * null when the literal `node` install directory is the only evidence.
       */
      readonly provenNodePrefix: string | null;
    }
  /** Mise is involved, but `mise upgrade` cannot be shown to reach the executable. */
  | { readonly kind: "uncertain"; readonly reason: string }
  | {
      readonly kind: "tool";
      /** The mise that resolved ownership; the upgrade must run the same one. */
      readonly executable: string;
      /** The environment the provider's launcher gives mise; the upgrade runs in it too. */
      readonly env: NodeJS.ProcessEnv;
      /**
       * What `mise upgrade` and `mise outdated` take: the tool as mise's config
       * names it (alias or backend spec), or `<tool>@latest` for a launcher
       * that runs that explicit selection instead of the configured one.
       */
      readonly selection: string;
      /** Newest version `mise upgrade` installs within the configured request. */
      readonly latestVersion: string | null;
    };

/** How the provider executable reaches mise, read from the filesystem alone. */
type MiseLaunch =
  | { readonly kind: "none" }
  /** A launcher reaches mise in a way T3 Code cannot follow. */
  | { readonly kind: "declined"; readonly reason: string }
  /** The executable is a file inside a tool's install directory. */
  | {
      readonly kind: "install-tree";
      readonly launchPath: string;
      readonly realPath: string;
      readonly env: NodeJS.ProcessEnv;
    }
  /** A mise shim or `mise exec` picks the binary named `bin` at run time. */
  | {
      readonly kind: "bin";
      readonly bin: string;
      /** The mise binary the launcher runs, when it names one; otherwise mise on PATH. */
      readonly executable: string | null;
      /** The tool spec a `mise exec` wrapper requests. */
      readonly spec: string | null;
      readonly env: NodeJS.ProcessEnv;
    };

const UNRELATED: MiseOwnership = { kind: "unrelated" };
const NO_LAUNCH: MiseLaunch = { kind: "none" };

/**
 * Ask mise which tool owns the provider executable. Probes run with the
 * environment the provider's launcher runs with (`MISE_DATA_DIR`,
 * `MISE_CONFIG_DIR`, PATH) and the server's cwd, like the provider's own
 * version probe, so they see the installation and config the provider runs
 * with. Only paths that already point at mise start a probe.
 */
export const resolveMiseOwnership = Effect.fn("resolveMiseOwnership")(function* (
  context: ProviderMaintenanceResolutionContext,
) {
  const launch = yield* findMiseLaunch(context);
  switch (launch.kind) {
    case "none":
      return UNRELATED;
    case "declined":
      return uncertain(launch.reason);
    case "install-tree": {
      const executable = yield* findMiseOnPath(launch.env);
      const owner =
        executable === null
          ? null
          : yield* findOwningTool({
              executable,
              env: launch.env,
              platform: context.platform,
              launchPath: launch.launchPath,
              binPath: launch.launchPath,
              realBinPath: launch.realPath,
              spec: null,
            });
      if (owner) return owner;
      // asdf shares the `installs/<tool>/<version>` layout, so only this
      // environment's own mise data root keeps the path from the npm rules.
      const installRelativePath = yield* pathBelowMiseInstalls(
        launch.realPath,
        launch.env,
        context.platform,
      );
      if (installRelativePath === null) return UNRELATED;
      if (/^node\/[^/]+\/(?:.*\/)?node_modules\//.test(installRelativePath)) {
        return {
          kind: "npm-global",
          resolvedCommandPath: launch.launchPath,
          realCommandPath: launch.realPath,
          provenNodePrefix: null,
        } satisfies MiseOwnership;
      }
      return uncertain(
        `${launch.realPath} is inside mise's installs, but mise could not say which tool owns it.`,
      );
    }
    case "bin": {
      const executable = launch.executable ?? (yield* findMiseOnPath(launch.env));
      if (!executable) {
        return uncertain(`\`${launch.bin}\` runs through mise, but no mise executable is on PATH.`);
      }
      const spec = launch.spec === null ? null : splitToolSpec(launch.spec);
      // `which --tool` resolves the launcher's own selection without
      // installing it, which `mise exec` would do.
      const binPath = (yield* runInstallerProbe({
        executable,
        args: spec?.version ? ["which", "--tool", launch.spec!, launch.bin] : ["which", launch.bin],
        env: launch.env,
        timeout: MISE_PROBE_TIMEOUT,
        maxBytes: MISE_PROBE_MAX_BYTES,
      }))?.trim();
      if (!binPath) {
        return uncertain(`mise has no active tool that provides \`${launch.bin}\`.`);
      }
      const fileSystem = yield* FileSystem.FileSystem;
      const realBinPath = yield* fileSystem
        .realPath(binPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!realBinPath) {
        return uncertain(`mise resolves \`${launch.bin}\` to ${binPath}, which does not exist.`);
      }
      const owner = yield* findOwningTool({
        executable,
        env: launch.env,
        platform: context.platform,
        // Shims and `mise exec` pick the version at run time, so nothing pins it.
        launchPath: null,
        binPath,
        realBinPath,
        spec,
      });
      return (
        owner ??
        uncertain(`mise could not attribute \`${launch.bin}\` (${binPath}) to an installed tool.`)
      );
    }
  }
});

function uncertain(reason: string): MiseOwnership {
  return { kind: "uncertain", reason };
}

/**
 * Recognize the ways a mise-managed provider shows up: a shim (on POSIX a
 * symlink to the mise binary, which dispatches on the name it was run as), a
 * path inside a tool's install directory, or a launcher script whose final
 * `exec` runs a shim, an install path, or `mise exec`. Omarchy writes such
 * launchers to `~/.local/bin/<tool>`.
 */
const findMiseLaunch = Effect.fn("findMiseLaunch")(function* (
  context: ProviderMaintenanceResolutionContext,
) {
  const shim = yield* readMiseShim({
    launchPath: context.resolvedCommandPath,
    realPath: context.realCommandPath,
    platform: context.platform,
    env: context.env,
  });
  if (shim) return shim;
  if (isInsideInstallTree(context.realCommandPath)) {
    return {
      kind: "install-tree",
      launchPath: context.resolvedCommandPath,
      realPath: context.realCommandPath,
      env: context.env,
    } satisfies MiseLaunch;
  }

  const launcher = yield* readLauncher(context.realCommandPath, context.env);
  if (!launcher) return NO_LAUNCH;
  const target = yield* readLaunchTarget({
    argv: launcher.argv,
    env: launcher.kind === "followed" ? launcher.env : context.env,
    platform: context.platform,
  });
  if (target.kind === "none" || launcher.kind === "followed") return target;
  return { kind: "declined", reason: launcher.reason } satisfies MiseLaunch;
});

/**
 * POSIX shims are symlinks to the mise binary. Windows shims are `.cmd`
 * files or copies of `mise-shim.exe` in `<data>/shims`, next to `installs`.
 */
const readMiseShim = Effect.fn("readMiseShim")(function* (input: {
  readonly launchPath: string;
  readonly realPath: string;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
}) {
  const path = yield* Path.Path;
  const bin = commandName(input.launchPath, path);
  if (bin.toLowerCase() === "mise") return null;
  const realName = commandName(input.realPath, path).toLowerCase();
  if (realName === "mise" || realName === "mise-shim") {
    return {
      kind: "bin",
      bin,
      executable: realName === "mise" ? input.realPath : null,
      spec: null,
      env: input.env,
    } satisfies MiseLaunch;
  }
  if (input.platform !== "win32") return null;
  const shimDir = path.dirname(input.launchPath);
  if (path.basename(shimDir).toLowerCase() !== "shims") return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const hasInstalls = yield* fileSystem
    .exists(path.join(path.dirname(shimDir), "installs"))
    .pipe(Effect.orElseSucceed(() => false));
  return hasInstalls
    ? ({ kind: "bin", bin, executable: null, spec: null, env: input.env } satisfies MiseLaunch)
    : null;
});

/** What a launcher's final `exec` runs: `mise exec`, a shim, or an install path. */
const readLaunchTarget = Effect.fn("readLaunchTarget")(function* (input: {
  readonly argv: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}) {
  const path = yield* Path.Path;
  const miseExec = readMiseExec(input.argv, input.env, path);
  if (miseExec) return miseExec;
  const target = input.argv[0]!;
  if (!path.isAbsolute(target)) return NO_LAUNCH;
  const fileSystem = yield* FileSystem.FileSystem;
  const realTarget = yield* fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => null));
  if (!realTarget) return NO_LAUNCH;
  const targetShim = yield* readMiseShim({
    launchPath: target,
    realPath: realTarget,
    platform: input.platform,
    env: input.env,
  });
  if (targetShim) return targetShim;
  return isInsideInstallTree(realTarget)
    ? ({
        kind: "install-tree",
        launchPath: target,
        realPath: realTarget,
        env: input.env,
      } satisfies MiseLaunch)
    : NO_LAUNCH;
});

function commandName(commandPath: string, path: Path.Path): string {
  return path.basename(commandPath).replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
}

function isInsideInstallTree(realPath: string): boolean {
  return realPath.replaceAll("\\", "/").includes("/installs/");
}

/**
 * `[/path/to/]mise x|exec <spec> -- <bin>`, with no options before `--` and
 * no arguments after `<bin>`: in `mise x node -- node cli.js` the provider is
 * `cli.js`, not the node tool.
 */
function readMiseExec(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  path: Path.Path,
): MiseLaunch | null {
  if (argv.length !== 5) return null;
  const [mise, subcommand, spec, separator, bin] = argv;
  if (!mise || commandName(mise, path).toLowerCase() !== "mise") return null;
  if (subcommand !== "x" && subcommand !== "exec") return null;
  if (!spec || spec.startsWith("-") || separator !== "--" || !bin) return null;
  if (mise !== "mise" && !path.isAbsolute(mise)) return null;
  return { kind: "bin", bin, executable: mise === "mise" ? null : mise, spec, env };
}

/**
 * `claude`, `npm:@openai/codex`, `claude@latest`, `npm:@openai/codex@0.1`.
 * The `@` that opens an npm scope follows the backend's colon or starts the spec.
 */
function splitToolSpec(spec: string): ToolSpec {
  const at = spec.lastIndexOf("@");
  return at > 0 && spec[at - 1] !== ":"
    ? { tool: spec.slice(0, at), version: spec.slice(at + 1) }
    : { tool: spec, version: null };
}

interface ToolSpec {
  readonly tool: string;
  readonly version: string | null;
}

/**
 * What a launcher script's final `exec` runs. `followed` carries the
 * environment the script hands to it. `declined` means the script changes
 * mise's environment or working directory in a way T3 Code does not follow,
 * so ownership must not be proven against the original environment.
 */
type Launcher =
  | {
      readonly kind: "followed";
      readonly argv: ReadonlyArray<string>;
      readonly env: NodeJS.ProcessEnv;
    }
  | { readonly kind: "declined"; readonly argv: ReadonlyArray<string>; readonly reason: string };

const readLauncher = Effect.fn("readLauncher")(function* (
  scriptPath: string,
  env: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(scriptPath).pipe(Effect.orElseSucceed(() => null));
  if (!info || info.type !== "File" || Number(info.size) > LAUNCHER_SCRIPT_MAX_BYTES) return null;
  const script = yield* fileSystem
    .readFileString(scriptPath)
    .pipe(Effect.orElseSucceed(() => null));
  return script?.startsWith("#!") ? readLauncherScript(script, env) : null;
});

// Mise settings that only shape which version an install picks, not which
// installation or config is in play. Omarchy's launchers set this one.
const VERSION_POLICY_VARIABLES = new Set(["MISE_MINIMUM_RELEASE_AGE"]);
// Commands whose effect on later lines T3 Code cannot follow.
const OPAQUE_COMMANDS = new Set([
  "source",
  ".",
  "eval",
  "unset",
  "read",
  "mapfile",
  "readarray",
  "getopts",
  "local",
  "declare",
  "typeset",
  "readonly",
  "alias",
  "trap",
]);
const UNSUPPORTED_RESERVED_WORDS = new Set([
  "case",
  "esac",
  "for",
  "select",
  "while",
  "until",
  "do",
  "done",
  "function",
  "{",
  "}",
  "time",
  "coproc",
]);
const ASSIGNMENT_WORD = /^([A-Za-z_]\w*)=(.*)$/s;

interface LauncherState {
  /** Shell variables the script assigned; null when the value is unknown. */
  readonly variables: Map<string, string | null>;
  readonly env: NodeJS.ProcessEnv;
  unsupported: string | null;
}

/**
 * Read a launcher script without running it. The only command T3 Code
 * attributes to the launcher is an unconditional top-level `exec`: anything
 * before it is setup, and `|| exit` may end the script early but cannot run
 * anything else. An `exec` inside an `if`, a plain `exit`, or a construct this
 * reader does not model (loops, `case`, functions, subshells, `$(…)`,
 * `source`) means it cannot say what the launcher runs. Variables are only
 * known when assigned unconditionally at the top level; a conditional
 * assignment makes the variable unknown. Changes to mise's environment are
 * carried into the probes, or declined when they are conditional or
 * unevaluable, except version policy that does not choose the installation.
 */
function readLauncherScript(script: string, env: NodeJS.ProcessEnv): Launcher | null {
  const state: LauncherState = { variables: new Map(), env: { ...env }, unsupported: null };
  let depth = 0;
  for (const line of script.split(/\r?\n/)) {
    if (line.trimEnd().endsWith("\\")) return null;
    const segments = splitShellCommands(line);
    if (!segments) return null;
    for (const segment of segments) {
      let words = segment.words;
      if (words[0] === "if") {
        depth += 1;
        words = words.slice(1);
      } else if (words[0] === "then" || words[0] === "else" || words[0] === "elif") {
        if (depth === 0) return null;
        words = words.slice(1);
      } else if (words[0] === "fi") {
        if (depth === 0 || words.length > 1) return null;
        depth -= 1;
        continue;
      }
      if (words[0] === "!") words = words.slice(1);
      if (words.length === 0) continue;
      if (UNSUPPORTED_RESERVED_WORDS.has(words[0]!)) return null;

      const conditional = depth > 0 || segment.before === "&&" || segment.before === "||";
      const inPipeline = segment.before === "|" || segment.after === "|";
      const assignmentCount = words.findIndex((word) => !ASSIGNMENT_WORD.test(word));
      if (assignmentCount === -1) {
        // Pipeline members run in subshells; their assignments do not stick.
        if (inPipeline) return null;
        for (const word of words)
          recordLauncherWrite(state, word, { exported: false, conditional });
        continue;
      }
      const [command, ...args] = words.slice(assignmentCount);
      switch (command) {
        case "exec": {
          if (depth > 0 || segment.before !== null || segment.after !== null) return null;
          if (assignmentCount > 0) return null;
          const argv = readExecArgv(args, state);
          if (!argv) return null;
          return state.unsupported === null
            ? { kind: "followed", argv, env: state.env }
            : { kind: "declined", argv, reason: state.unsupported };
        }
        case "exit":
        case "return":
        case "logout":
          if (segment.before !== "||") return null;
          continue;
        case "export":
          if (inPipeline) return null;
          for (const arg of args) {
            if (arg.startsWith("-")) return null;
            if (ASSIGNMENT_WORD.test(arg)) {
              recordLauncherWrite(state, arg, { exported: true, conditional });
            } else {
              recordLauncherExport(state, arg, conditional);
            }
          }
          continue;
        case "cd":
        case "pushd":
        case "popd":
          state.unsupported ??=
            "The launcher changes directory before it runs the tool, so mise would read a different config.";
          continue;
        case "set":
          if (args.some((arg) => /^-\w*a/.test(arg) || arg === "allexport")) return null;
          continue;
        default:
          if (command && OPAQUE_COMMANDS.has(command)) return null;
      }
    }
  }
  return null;
}

/** Words of one line's simple commands, with the list operator on each side. */
function splitShellCommands(line: string): Array<{
  readonly words: ReadonlyArray<string>;
  readonly before: string | null;
  readonly after: string | null;
}> | null {
  const segments: Array<{ words: Array<string>; before: string | null; after: string | null }> = [];
  let current: { words: Array<string>; before: string | null; after: string | null } = {
    words: [],
    before: null,
    after: null,
  };
  const tokenPattern =
    /\s*(?:(#.*)|(\|\||&&|;;|[;|&()])|((?:\d*[<>]+&?|[^\s'"`;&|()<>]|'[^']*'|"(?:[^"\\`]|\\.)*")+))/y;
  let position = 0;
  for (;;) {
    tokenPattern.lastIndex = position;
    const match = tokenPattern.exec(line);
    if (!match) break;
    position = tokenPattern.lastIndex;
    if (match[1] !== undefined) break;
    const operator = match[2];
    if (operator === undefined) {
      // A heredoc's body would follow on lines read as commands.
      if (/^\d*<</.test(match[3]!)) return null;
      current.words.push(match[3]!);
      continue;
    }
    if (operator !== ";" && operator !== "&&" && operator !== "||" && operator !== "|") {
      return null;
    }
    current.after = operator === ";" ? null : operator;
    if (current.words.length > 0) segments.push(current);
    current = { words: [], before: operator === ";" ? null : operator, after: null };
  }
  if (current.words.length > 0) segments.push(current);
  // An unterminated quote leaves text the token pattern could not consume.
  return line.slice(position).trim() === "" ? segments : null;
}

/** The exec'd argv, expanded, with a trailing `"$@"` dropped. */
function readExecArgv(
  words: ReadonlyArray<string>,
  state: LauncherState,
): ReadonlyArray<string> | null {
  const expanded: Array<string> = [];
  for (const word of words) {
    const value = expandShellWord(word, state);
    if (value === null) return null;
    expanded.push(value);
  }
  const argv = expanded.at(-1) === "$@" ? expanded.slice(0, -1) : expanded;
  if (argv.length === 0 || argv[0]!.startsWith("-")) return null;
  return argv.some((word) => word.includes("$@")) ? null : argv;
}

function steersMise(name: string): boolean {
  return /^(?:MISE_|XDG_)/.test(name) || name === "PATH" || name === "HOME";
}

function recordLauncherWrite(
  state: LauncherState,
  word: string,
  options: { readonly exported: boolean; readonly conditional: boolean },
) {
  const [, name, raw] = ASSIGNMENT_WORD.exec(word)!;
  if (options.conditional) {
    state.variables.set(name!, null);
    if (steersMise(name!) && !VERSION_POLICY_VARIABLES.has(name!)) {
      state.unsupported ??= `The launcher changes ${name} on only some runs.`;
    }
    return;
  }
  const value = expandShellWord(raw!, state);
  // A plain assignment to a variable already in the environment changes what
  // the exec'd process inherits, like `export` does.
  const variableName: string = name!;
  const reachesChild = options.exported || variableName in state.env;
  state.variables.set(name!, value);
  if (!reachesChild || !steersMise(name!)) return;
  if (value === null) {
    state.unsupported ??= `The launcher sets ${name} to a value T3 Code cannot evaluate.`;
    return;
  }
  state.env[name!] = value;
}

function recordLauncherExport(state: LauncherState, name: string, conditional: boolean) {
  if (!steersMise(name) || !state.variables.has(name)) return;
  const value = state.variables.get(name);
  if (conditional || value === null || value === undefined) {
    if (!VERSION_POLICY_VARIABLES.has(name)) {
      state.unsupported ??= `The launcher exports ${name} with a value T3 Code cannot follow.`;
    }
    return;
  }
  state.env[name] = value;
}

/**
 * Expand one shell word: bare text, `'…'`, and `"…"`, with `~`, `$NAME`, and
 * `${NAME}` taken from the launcher's variables or environment. `$@` stays
 * literal. Escapes, substitutions, globs, and unknown variables yield null.
 */
function expandShellWord(raw: string, state: LauncherState): string | null {
  let word = "";
  for (const [segment] of raw.matchAll(/'[^']*'|"[^"]*"|[^'"]+/g)) {
    if (segment.startsWith("'")) {
      word += segment.slice(1, -1);
      continue;
    }
    const quoted = segment.startsWith('"');
    const text = quoted ? segment.slice(1, -1) : segment;
    if (/[\\`]/.test(text) || (!quoted && /[;&|<>()*?[\]]/.test(text))) return null;
    let homeExpanded = text;
    if (!quoted && word === "" && /^~(?:\/|$)/.test(text)) {
      const home = lookupLauncherVariable(state, "HOME");
      if (home === undefined) return null;
      homeExpanded = `${home}${text.slice(1)}`;
    }
    const expanded = expandShellVariables(homeExpanded, state);
    if (expanded === null) return null;
    word += expanded;
  }
  return word;
}

function expandShellVariables(text: string, state: LauncherState): string | null {
  let unknown = false;
  const expanded = text.replace(
    /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*)|(@))/g,
    (_, braced: string | undefined, bare: string | undefined, all: string | undefined) => {
      if (all) return "$@";
      const value = lookupLauncherVariable(state, (braced ?? bare)!);
      if (value === undefined) unknown = true;
      return value ?? "";
    },
  );
  // Any `$` left over is an expansion we do not evaluate.
  return unknown || expanded.replaceAll("$@", "").includes("$") ? null : expanded;
}

function lookupLauncherVariable(state: LauncherState, name: string): string | undefined {
  return state.variables.has(name) ? (state.variables.get(name) ?? undefined) : state.env[name];
}

const findMiseOnPath = (env: NodeJS.ProcessEnv) =>
  resolveCommandPath("mise", { env }).pipe(
    Effect.catchTags({ CommandResolutionError: () => Effect.succeed(null) }),
  );

/**
 * Where `realPath` sits below this environment's mise `installs/`, or null.
 * Mirrors mise's data dir: `MISE_DATA_DIR`, else `$XDG_DATA_HOME/mise` or
 * `~/.local/share/mise`, and `%LOCALAPPDATA%\mise` on Windows.
 */
const pathBelowMiseInstalls = Effect.fn("pathBelowMiseInstalls")(function* (
  realPath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const defaultRoot =
    platform === "win32"
      ? env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "mise")
      : env.XDG_DATA_HOME
        ? path.join(env.XDG_DATA_HOME, "mise")
        : env.HOME && path.join(env.HOME, ".local", "share", "mise");
  for (const root of [env.MISE_DATA_DIR, defaultRoot]) {
    if (!root) continue;
    const installs = path.join(root, "installs");
    const realInstalls = yield* fileSystem
      .realPath(installs)
      .pipe(Effect.orElseSucceed(() => installs));
    const below =
      pathBelow(installs, realPath, platform) ?? pathBelow(realInstalls, realPath, platform);
    if (below !== null) return below;
  }
  return null;
});

const MiseInstalledTools = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        version: Schema.String,
        install_path: Schema.String,
        requested_version: Schema.optional(Schema.String),
        active: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
);
const decodeMiseInstalledTools = Schema.decodeUnknownOption(MiseInstalledTools);

const MiseOutdatedTools = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Struct({ latest: Schema.String })),
);
const decodeMiseOutdatedTools = Schema.decodeUnknownOption(MiseOutdatedTools);

/**
 * Match the real binary against every install mise reports, so the tool name
 * is mise's own (alias, backend spec, custom data dir) rather than a guess
 * from directory names. Null when mise cannot list its installs or none
 * contains the binary.
 */
const findOwningTool = Effect.fn("findOwningMiseTool")(function* (input: {
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** The path T3 Code launches when it names an install path; null when mise picks at run time. */
  readonly launchPath: string | null;
  /** The provider binary inside the install, before and after following symlinks. */
  readonly binPath: string;
  readonly realBinPath: string;
  /** The tool a `mise exec` launcher requests. */
  readonly spec: ToolSpec | null;
}) {
  const listing = yield* runInstallerProbe({
    executable: input.executable,
    args: ["ls", "--installed", "--json"],
    env: input.env,
    timeout: MISE_PROBE_TIMEOUT,
    maxBytes: MISE_PROBE_MAX_BYTES,
  });
  if (listing === null) return null;
  const tools = decodeMiseInstalledTools(listing);
  if (Option.isNone(tools)) {
    yield* Effect.logWarning("mise ls --json printed an unexpected shape", {
      executable: input.executable,
    });
    return null;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [tool, installs] of Object.entries(tools.value)) {
    for (const install of installs) {
      const installPath = yield* fileSystem
        .realPath(install.install_path)
        .pipe(Effect.orElseSucceed(() => install.install_path));
      const relativeBinPath = pathBelow(installPath, input.realBinPath, input.platform);
      if (relativeBinPath === null) continue;

      // A binary inside node_modules is either the package an npm backend
      // installed or an npm global under a Node install, whatever the tool's
      // alias. Only mise's own backend name tells them apart.
      if (relativeBinPath.includes("node_modules/") && !tool.startsWith("npm:")) {
        const backend = isNodeBackend(tool)
          ? tool
          : (yield* runInstallerProbe({
              executable: input.executable,
              args: ["tool", "--backend", tool],
              env: input.env,
              timeout: MISE_PROBE_TIMEOUT,
              maxBytes: MISE_PROBE_MAX_BYTES,
            }))?.trim();
        if (backend && isNodeBackend(backend)) {
          return {
            kind: "npm-global",
            resolvedCommandPath: input.binPath,
            realCommandPath: input.realBinPath,
            provenNodePrefix: installPath,
          } satisfies MiseOwnership;
        }
        if (!backend?.startsWith("npm:")) {
          return uncertain(
            `${tool} holds the binary inside node_modules, but mise did not show that its backend (${backend || "unknown"}) is the provider's npm package rather than a Node install.`,
          );
        }
      }
      if (input.spec && input.spec.tool !== tool) {
        return uncertain(
          `The launcher runs ${input.spec.tool}, but mise resolves the binary from ${tool}.`,
        );
      }
      // A launcher's `tool@latest` is its own selection: `mise upgrade
      // tool@latest` moves it and leaves the config's request alone. Any other
      // request is only what `mise upgrade` moves when the config makes it.
      const requestedVersion = input.spec?.version ?? null;
      const explicitLatest =
        requestedVersion === "latest" && install.requested_version !== "latest";
      if (
        requestedVersion !== null &&
        !explicitLatest &&
        requestedVersion !== install.requested_version
      ) {
        return uncertain(
          `The launcher runs ${tool}@${requestedVersion}, but mise's config requests ${tool}@${install.requested_version ?? "nothing"}.`,
        );
      }
      if (!explicitLatest && !install.active) {
        return uncertain(
          `${tool}@${install.version} is installed by mise, but mise's config does not select it, so \`mise upgrade\` would not change it.`,
        );
      }
      const selection = explicitLatest ? `${tool}@latest` : tool;
      const entry =
        input.launchPath === null
          ? null
          : yield* findInstallEntry({
              launchPath: input.launchPath,
              toolDirs: [path.dirname(install.install_path), path.dirname(installPath)],
              platform: input.platform,
            });
      if (input.launchPath !== null && entry?.kind !== "selector") {
        return uncertain(
          `T3 Code launches ${tool} through ${entry?.path ?? input.launchPath}, which names mise's fixed ${entry?.name ?? install.version} install. \`mise upgrade\` installs beside it, so point the provider at the mise shim or the \`latest\` link.`,
        );
      }

      const outdated = yield* runInstallerProbe({
        executable: input.executable,
        args: ["outdated", "--json", selection],
        env: input.env,
        timeout: MISE_OUTDATED_TIMEOUT,
        maxBytes: MISE_PROBE_MAX_BYTES,
      });
      // `outdated` lists only tools behind their request, keyed by tool, so a
      // missing entry means the installed version is all `mise upgrade` reaches.
      // That is what keeps an exact pin from advertising an unreachable update.
      const latestVersion =
        outdated === null
          ? null
          : Option.match(decodeMiseOutdatedTools(outdated), {
              onNone: () => null,
              onSome: (outdatedTools) => outdatedTools[tool]?.latest ?? install.version,
            });
      // A range link such as `2.1` keeps pointing inside its range.
      if (
        entry !== null &&
        entry.name !== "latest" &&
        latestVersion !== null &&
        latestVersion !== entry.name &&
        !latestVersion.startsWith(`${entry.name}.`)
      ) {
        return uncertain(
          `T3 Code launches ${tool} through mise's \`${entry.name}\` link, which an upgrade to ${latestVersion} would not move.`,
        );
      }
      return {
        kind: "tool",
        executable: input.executable,
        env: input.env,
        selection,
        latestVersion,
      } satisfies MiseOwnership;
    }
  }
  return null;
});

/**
 * Which entry of a tool's install directory the launch path first passes
 * through while its symlinks resolve: a selector link mise moves on upgrade
 * (`latest`, `2`, `2.1`) or a fixed version directory. A symlink from
 * elsewhere straight into `2.1.0/` stays on 2.1.0 forever.
 */
const findInstallEntry = Effect.fn("findInstallEntry")(function* (input: {
  readonly launchPath: string;
  readonly toolDirs: ReadonlyArray<string>;
  readonly platform: NodeJS.Platform;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const launchPath of yield* listSymlinkPaths(input.launchPath)) {
    for (const toolDir of input.toolDirs) {
      const below = pathBelow(toolDir, launchPath, input.platform);
      if (below === null) continue;
      const name = below.split("/", 1)[0]!;
      const isLink = yield* fileSystem.readLink(path.join(toolDir, name)).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      return { kind: isLink ? "selector" : "version", name, path: launchPath } as const;
    }
  }
  return null;
});

/** `node`, `core:node`, or a plugin backend for Node such as `asdf:nodejs`. */
function isNodeBackend(backend: string): boolean {
  return /(?:^|[:/])node(?:js)?$/.test(backend);
}

/**
 * Every spelling of `start` while its symlinks resolve, one link at a time
 * from the root down, ending at the real path.
 */
const listSymlinkPaths = Effect.fn("listSymlinkPaths")(function* (start: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spellings = [path.resolve(start)];
  for (let hop = 0; hop < SYMLINK_HOPS_MAX; hop += 1) {
    const current = spellings.at(-1)!;
    const { root } = path.parse(current);
    const components = current.slice(root.length).split(path.sep).filter(Boolean);
    let prefix = root;
    let next: string | null = null;
    for (const [index, component] of components.entries()) {
      const candidate = path.join(prefix, component);
      const target = yield* fileSystem.readLink(candidate).pipe(Effect.option);
      if (Option.isSome(target)) {
        next = path.resolve(prefix, target.value, ...components.slice(index + 1));
        break;
      }
      prefix = candidate;
    }
    if (next === null) return spellings;
    spellings.push(next);
  }
  return spellings;
});

/** The part of `child` below `parent` with forward slashes, or null when it is not below. */
function pathBelow(parent: string, child: string, platform: NodeJS.Platform): string | null {
  const prefix = `${comparablePath(parent, platform)}/`;
  const candidate = comparablePath(child, platform);
  return candidate.startsWith(prefix) ? candidate.slice(prefix.length) : null;
}

function comparablePath(value: string, platform: NodeJS.Platform): string {
  const slashed = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? slashed.toLowerCase() : slashed;
}
