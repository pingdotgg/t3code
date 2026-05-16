import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { satisfiesSemverRange } from "@t3tools/shared/semver";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { parseWslDistroList, type WslDistro } from "./wslPathParsing.ts";

const PROCESS_TERMINATE_GRACE = Duration.seconds(1);
const LIST_TIMEOUT = Duration.seconds(8);
const PRE_WARM_TIMEOUT = Duration.seconds(10);
const WSLPATH_TIMEOUT = Duration.seconds(10);
const PROBE_TIMEOUT = Duration.seconds(10);
const TOOLCHAIN_TIMEOUT = Duration.seconds(10);
const BUILD_TIMEOUT = Duration.minutes(5);
const USER_HOME_TIMEOUT = Duration.seconds(5);

export interface EnsureWslNodePtyOptions {
  readonly allowBuild?: boolean;
  readonly nodeEngineRange?: string | null;
}

export type EnsureWslNodePtyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface DesktopWslEnvironmentShape {
  readonly isAvailable: Effect.Effect<boolean>;
  readonly listDistros: Effect.Effect<readonly WslDistro[]>;
  readonly preWarm: (distro: string | null) => Effect.Effect<void>;
  readonly windowsToWslPath: (
    distro: string | null,
    windowsPath: string,
  ) => Effect.Effect<Option.Option<string>>;
  // Resolves the user's Linux home dir inside the chosen distro (e.g.
  // "/home/josh"). Used by the folder picker to expand `~` correctly.
  readonly getUserHome: (distro: string | null) => Effect.Effect<Option.Option<string>>;
  readonly ensureNodePty: (
    distro: string | null,
    windowsRepoRoot: string,
    options?: EnsureWslNodePtyOptions,
  ) => Effect.Effect<EnsureWslNodePtyResult>;
}

export class DesktopWslEnvironment extends Context.Service<
  DesktopWslEnvironment,
  DesktopWslEnvironmentShape
>()("t3/desktop/WslEnvironment") {}

const buildDistroArgs = (distro: string | null): ReadonlyArray<string> =>
  distro ? ["-d", distro] : [];

const concatChunks = (arrays: ReadonlyArray<Uint8Array>): Uint8Array => {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.byteLength;
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.byteLength;
  }
  return out;
};

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8").decode(bytes);

interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const TIMEOUT_RESULT: ShellResult = { exitCode: 124, stdout: "", stderr: "\n[timeout]" };

// wsl.exe re-escapes args before forwarding them to the Linux side, which
// mangles quotes inside `bash -lc "<script>"`. Pipe the script via stdin to
// avoid passing it on the command line at all.
const runWslShell = (
  distro: string | null,
  bashScript: string,
  timeout: Duration.Duration,
): Effect.Effect<ShellResult, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const spawner = ChildProcessSpawner.ChildProcessSpawner;
  // -l so nvm/profile-managed tools (node, node-gyp) are on PATH;
  // -s so bash reads the script from stdin instead of the command line.
  const command = ChildProcess.make(
    "wsl.exe",
    [...buildDistroArgs(distro), "--", "bash", "-l", "-s"],
    {
      stdin: Stream.encodeText(Stream.make(bashScript)),
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: PROCESS_TERMINATE_GRACE,
    },
  );

  return Effect.scoped(
    Effect.gen(function* () {
      const spawnerService = yield* spawner;
      const handle = yield* spawnerService.spawn(command);
      // Drain stdout and stderr concurrently so neither pipe buffer can fill
      // and stall the child (node-gyp rebuild emits large output on both).
      const [stdoutBytes, stderrBytes, exitCode] = yield* Effect.all(
        [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return {
        exitCode: exitCode as unknown as number,
        stdout: decodeUtf8(concatChunks(stdoutBytes)),
        stderr: decodeUtf8(concatChunks(stderrBytes)),
      } satisfies ShellResult;
    }),
  ).pipe(
    Effect.timeoutOption(timeout),
    Effect.map(Option.getOrElse((): ShellResult => TIMEOUT_RESULT)),
    Effect.catch((error) =>
      Effect.succeed<ShellResult>({
        exitCode: 127,
        stdout: "",
        stderr: `\n${error.message}`,
      }),
    ),
  );
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const NODE_PTY_PROBE_SCRIPT = (
  linuxServerDir: string,
) => `cd ${shellQuote(linuxServerDir)} && node <<'NODE' >/dev/null 2>&1
const fs = require("node:fs");
const path = require("node:path");
const pkgDir = path.dirname(require.resolve("node-pty/package.json"));
const expected = {
  arch: process.arch,
  modules: process.versions.modules,
  nodePtyVersion: require("node-pty/package.json").version,
};
const marker = path.join(pkgDir, "prebuilds", "linux-" + process.arch, "t3code-wsl-node-pty.json");
require("node-pty");
const actual = JSON.parse(fs.readFileSync(marker, "utf8"));
for (const key of Object.keys(expected)) {
  if (actual[key] !== expected[key]) process.exit(2);
}
NODE`;

const TOOLCHAIN_CHECK_SCRIPT = [
  "for tool in node make g++ python3; do",
  '  command -v "$tool" >/dev/null 2>&1 || echo "missing:$tool"',
  "done",
  "if command -v node >/dev/null 2>&1; then",
  `  ver="$(node -p 'process.versions.node' 2>/dev/null)"`,
  '  if [ -n "$ver" ]; then printf "nodeVersion:%s\\n" "$ver"; fi',
  "fi",
].join("\n");

const NODE_PTY_BUILD_SCRIPT = (linuxServerDir: string) =>
  [
    "set -e",
    `cd ${shellQuote(linuxServerDir)}`,
    `pkg_dir=$(node -p "require('node:path').dirname(require.resolve('node-pty/package.json'))")`,
    `arch=$(node -p "process.arch")`,
    `modules=$(node -p "process.versions.modules")`,
    `node_pty_version=$(node -p "require('node-pty/package.json').version")`,
    `cd "$pkg_dir"`,
    "npx --yes node-gyp rebuild",
    `prebuild_dir="prebuilds/linux-$arch"`,
    `mkdir -p "$prebuild_dir"`,
    `cp build/Release/pty.node "$prebuild_dir/pty.node"`,
    `printf '{"arch":"%s","modules":"%s","nodePtyVersion":"%s"}\\n' "$arch" "$modules" "$node_pty_version" > "$prebuild_dir/t3code-wsl-node-pty.json"`,
    `node -e 'require("node-pty")'`,
  ].join("\n");

export interface ToolchainReport {
  readonly missingTools: ReadonlyArray<string>;
  readonly nodeVersion: string | null;
}

export const parseToolchainReport = (stdout: string): ToolchainReport => {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const missingTools = lines
    .filter((line) => line.startsWith("missing:"))
    .map((line) => line.slice("missing:".length));
  const nodeVersionLine = lines.find((line) => line.startsWith("nodeVersion:"));
  const nodeVersion = nodeVersionLine
    ? nodeVersionLine.slice("nodeVersion:".length).trim() || null
    : null;
  return { missingTools, nodeVersion };
};

export const formatMissingToolsReason = (
  report: ToolchainReport,
  requiredRange: string | null,
): string | null => {
  const nodeMissing = report.missingTools.includes("node");
  const nodeOutOfRange =
    !nodeMissing &&
    requiredRange !== null &&
    report.nodeVersion !== null &&
    !satisfiesSemverRange(report.nodeVersion, requiredRange);
  const buildToolsMissing = report.missingTools.filter((tool) => tool !== "node");

  if (!nodeMissing && !nodeOutOfRange && buildToolsMissing.length === 0) {
    return null;
  }

  const issues: string[] = [];
  const remediations: string[] = [];

  if (nodeMissing) {
    issues.push("node");
    remediations.push(
      `Node.js${requiredRange ? ` satisfying \`${requiredRange}\`` : " 18+"} (e.g. via nvm)`,
    );
  } else if (nodeOutOfRange) {
    issues.push(`node ${report.nodeVersion} (requires ${requiredRange})`);
    remediations.push(
      `a newer Node.js satisfying \`${requiredRange}\` (e.g. \`nvm install 24 && nvm alias default 24\`)`,
    );
  }

  if (buildToolsMissing.length > 0) {
    issues.push(...buildToolsMissing);
    remediations.push(
      "the build toolchain (e.g. `sudo apt install -y build-essential python3` on Ubuntu/Debian)",
    );
  }

  return `WSL distro is missing required tools: ${issues.join(", ")}. Install ${remediations.join(" and ")}, then retry.`;
};

const ensureNodePtyImpl = (
  distro: string | null,
  windowsRepoRoot: string,
  windowsToWslPath: (
    distro: string | null,
    windowsPath: string,
  ) => Effect.Effect<Option.Option<string>>,
  options: EnsureWslNodePtyOptions = {},
): Effect.Effect<EnsureWslNodePtyResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const linuxRepoRootOption = yield* windowsToWslPath(distro, windowsRepoRoot);
    if (Option.isNone(linuxRepoRootOption)) {
      return {
        ok: false,
        reason: `wslpath conversion failed for ${windowsRepoRoot}`,
      } as const;
    }
    const linuxRepoRoot = linuxRepoRootOption.value;
    // node-pty lives in the apps/server workspace's node_modules; resolve from
    // there rather than the monorepo root, where Bun's hoist layout omits it.
    const linuxServerDir = `${linuxRepoRoot}/apps/server`;

    const probe = yield* runWslShell(distro, NODE_PTY_PROBE_SCRIPT(linuxServerDir), PROBE_TIMEOUT);
    if (probe.exitCode === 0) return { ok: true } as const;

    // Run the toolchain check before the allowBuild branch so a missing
    // node binary (or an out-of-range version, or missing build tools)
    // surfaces as a specific, actionable message in both dev and packaged
    // builds. Without this, packaged users with no node in their WSL distro
    // saw a generic "node-pty is not prepared" error pointing at a script
    // that itself would have failed for the same reason.
    const toolchainCheck = yield* runWslShell(distro, TOOLCHAIN_CHECK_SCRIPT, TOOLCHAIN_TIMEOUT);
    const report = parseToolchainReport(toolchainCheck.stdout);
    const missingReason = formatMissingToolsReason(report, options.nodeEngineRange?.trim() || null);
    if (missingReason !== null) {
      return { ok: false, reason: missingReason } as const;
    }

    if (options.allowBuild !== true) {
      return {
        ok: false,
        reason:
          "node-pty is not prepared for this WSL Node runtime. Run `bun run prepare:wsl` from this checkout, then restart the desktop app.",
      } as const;
    }

    const build = yield* runWslShell(distro, NODE_PTY_BUILD_SCRIPT(linuxServerDir), BUILD_TIMEOUT);
    if (build.exitCode === 0) return { ok: true } as const;
    const trimmedTail = `${build.stdout}${build.stderr}`.trim().slice(-500);
    return {
      ok: false,
      reason: `node-pty Linux build failed (exit ${build.exitCode}): ${trimmedTail || "no stderr captured"}`,
    } as const;
  });

const listDistrosImpl: Effect.Effect<
  readonly WslDistro[],
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.scoped(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("wsl.exe", ["--list", "--verbose"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      killSignal: "SIGTERM",
      forceKillAfter: PROCESS_TERMINATE_GRACE,
    });
    const handle = yield* spawner.spawn(command);
    const stdoutBytes = yield* Stream.runCollect(handle.stdout);
    const exitCode = yield* handle.exitCode;
    if ((exitCode as unknown as number) !== 0) {
      return [] as readonly WslDistro[];
    }
    return parseWslDistroList(Buffer.from(concatChunks(stdoutBytes)));
  }),
).pipe(
  Effect.timeoutOption(LIST_TIMEOUT),
  Effect.map(Option.getOrElse((): readonly WslDistro[] => [])),
  Effect.catch(() => Effect.succeed<readonly WslDistro[]>([])),
);

const preWarmImpl = (
  distro: string | null,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command = ChildProcess.make("wsl.exe", [...buildDistroArgs(distro), "--", "true"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        killSignal: "SIGTERM",
        forceKillAfter: PROCESS_TERMINATE_GRACE,
      });
      const handle = yield* spawner.spawn(command);
      yield* handle.exitCode;
    }),
  ).pipe(
    Effect.timeoutOption(PRE_WARM_TIMEOUT),
    Effect.asVoid,
    Effect.catch(() => Effect.void),
  );

const windowsToWslPathImpl = (
  distro: string | null,
  windowsPath: string,
): Effect.Effect<Option.Option<string>, never, ChildProcessSpawner.ChildProcessSpawner> => {
  // wsl.exe interprets backslashes as escape chars; normalize to forward slashes.
  const normalized = windowsPath.replaceAll("\\", "/");
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command = ChildProcess.make(
        "wsl.exe",
        [...buildDistroArgs(distro), "--", "wslpath", "-u", normalized],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: PROCESS_TERMINATE_GRACE,
        },
      );
      const handle = yield* spawner.spawn(command);
      const stdoutBytes = yield* Stream.runCollect(handle.stdout);
      const exitCode = yield* handle.exitCode;
      if ((exitCode as unknown as number) !== 0) return Option.none<string>();
      const converted = decodeUtf8(concatChunks(stdoutBytes)).trim();
      return converted.length > 0 ? Option.some(converted) : Option.none<string>();
    }),
  ).pipe(
    Effect.timeoutOption(WSLPATH_TIMEOUT),
    Effect.map(Option.flatten),
    Effect.catch(() => Effect.succeed(Option.none<string>())),
  );
};

const getUserHomeImpl = (
  distro: string | null,
): Effect.Effect<Option.Option<string>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command = ChildProcess.make(
        "wsl.exe",
        // printf so there's no trailing newline noise; getent so we get the
        // real home from /etc/passwd even if $HOME is unset for some reason.
        [
          ...buildDistroArgs(distro),
          "--",
          "sh",
          "-c",
          'printf "%s" "$(getent passwd "$(id -un)" | cut -d: -f6)"',
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: PROCESS_TERMINATE_GRACE,
        },
      );
      const handle = yield* spawner.spawn(command);
      const stdoutBytes = yield* Stream.runCollect(handle.stdout);
      const exitCode = yield* handle.exitCode;
      if ((exitCode as unknown as number) !== 0) return Option.none<string>();
      const home = decodeUtf8(concatChunks(stdoutBytes)).trim();
      return home.startsWith("/") ? Option.some(home) : Option.none<string>();
    }),
  ).pipe(
    Effect.timeoutOption(USER_HOME_TIMEOUT),
    Effect.map(Option.flatten),
    Effect.catch(() => Effect.succeed(Option.none<string>())),
  );

const makeIsAvailable = (
  platform: NodeJS.Platform,
  windir: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (platform !== "win32") return false;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const wslExePath = path.join(windir, "System32", "wsl.exe");
    return yield* fileSystem.exists(wslExePath).pipe(Effect.orElseSucceed(() => false));
  });

export interface DesktopWslEnvironmentTestStub {
  readonly isAvailable?: boolean;
  readonly distros?: ReadonlyArray<WslDistro>;
  readonly windowsToWslPath?: (distro: string | null, windowsPath: string) => Option.Option<string>;
  readonly getUserHome?: (distro: string | null) => Option.Option<string>;
  readonly ensureNodePty?: (
    distro: string | null,
    windowsRepoRoot: string,
    options?: EnsureWslNodePtyOptions,
  ) => EnsureWslNodePtyResult;
}

export const layerTest = (stub: DesktopWslEnvironmentTestStub = {}) =>
  Layer.succeed(
    DesktopWslEnvironment,
    DesktopWslEnvironment.of({
      isAvailable: Effect.succeed(stub.isAvailable ?? false),
      listDistros: Effect.succeed(stub.distros ?? []),
      preWarm: () => Effect.void,
      windowsToWslPath: (distro, windowsPath) =>
        Effect.succeed(stub.windowsToWslPath?.(distro, windowsPath) ?? Option.none()),
      getUserHome: (distro) => Effect.succeed(stub.getUserHome?.(distro) ?? Option.none<string>()),
      ensureNodePty: (distro, windowsRepoRoot, options) =>
        Effect.succeed(
          stub.ensureNodePty?.(distro, windowsRepoRoot, options) ?? {
            ok: false,
            reason: "ensureNodePty stub not configured",
          },
        ),
    }),
  );

export const layer = Layer.effect(
  DesktopWslEnvironment,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const windir = process.env.WINDIR ?? "C:\\Windows";

    const provideSpawner = <A, E>(
      effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
    ): Effect.Effect<A, E> =>
      effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

    const isAvailable = makeIsAvailable(environment.platform, windir).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, environment.path),
      Effect.withSpan("desktop.wsl.isAvailable"),
    );

    const windowsToWslPath = (distro: string | null, windowsPath: string) =>
      provideSpawner(windowsToWslPathImpl(distro, windowsPath)).pipe(
        Effect.withSpan("desktop.wsl.windowsToWslPath"),
      );

    // Cache user-home results per distro key — folder picker can be opened
    // many times in a session and the value is stable for the life of the
    // distro. Negative results aren't cached so a transient wsl.exe failure
    // doesn't permanently disable tilde expansion.
    const userHomeCache = new Map<string, string>();
    const getUserHome = (distro: string | null) =>
      Effect.gen(function* () {
        const key = distro ?? "__default__";
        const cached = userHomeCache.get(key);
        if (cached !== undefined) return Option.some(cached);
        const resolved = yield* provideSpawner(getUserHomeImpl(distro));
        if (Option.isSome(resolved)) userHomeCache.set(key, resolved.value);
        return resolved;
      }).pipe(Effect.withSpan("desktop.wsl.getUserHome"));

    return DesktopWslEnvironment.of({
      isAvailable,
      listDistros: provideSpawner(listDistrosImpl).pipe(Effect.withSpan("desktop.wsl.listDistros")),
      preWarm: (distro) =>
        provideSpawner(preWarmImpl(distro)).pipe(Effect.withSpan("desktop.wsl.preWarm")),
      windowsToWslPath,
      getUserHome,
      ensureNodePty: (distro, windowsRepoRoot, options) =>
        provideSpawner(ensureNodePtyImpl(distro, windowsRepoRoot, windowsToWslPath, options)).pipe(
          Effect.withSpan("desktop.wsl.ensureNodePty"),
        ),
    });
  }),
);
