/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser, workspace paths in
 * a configured editor, and generic external targets through the platform's
 * default opener.
 *
 * @module Open
 */
import OS from "node:os";
import { spawn as spawnNodeChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";

import { EDITORS, type EditorId } from "@t3tools/contracts";
import { Array, Effect, FileSystem, Layer, Option, Path, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  isWindowsBatchShim,
  makeWindowsCmdSpawnArguments,
  resolveWindowsCommandShell,
} from "../windowsCommand";
import {
  DesktopLauncherCommandNotFoundError,
  DesktopLauncherDiscoveryError,
  DesktopLauncherLaunchAttemptsExhaustedError,
  DesktopLauncherNonZeroExitError,
  DesktopLauncherSpawnError,
  DesktopLauncherUnknownEditorError,
  DesktopLauncherValidationError,
  DesktopLauncher,
  type DesktopLauncherShape,
  type OpenApplicationInput,
  type OpenExternalInput,
} from "../Services/DesktopLauncher";

export interface DetachedSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly detached?: boolean;
  readonly shell?: boolean;
  readonly windowsVerbatimArguments?: boolean;
  readonly windowsHide?: boolean;
  readonly stdin?: "ignore";
  readonly stdout?: "ignore";
  readonly stderr?: "ignore";
}

type DesktopLauncherOperation =
  | "getAvailableEditors"
  | "openBrowser"
  | "openExternal"
  | "openInEditor";

interface LaunchContext {
  readonly operation: DesktopLauncherOperation;
  readonly target?: string;
  readonly editor?: EditorId;
}

export interface LaunchRuntimeOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly isWsl?: boolean;
  readonly isInsideContainer?: boolean;
  readonly powerShellCommand?: string;
  readonly spawnDetached?: (
    input: DetachedSpawnInput,
    context: LaunchContext,
  ) => Effect.Effect<void, DesktopLauncherSpawnError>;
}

interface LaunchRuntime {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly isWsl: boolean;
  readonly isInsideContainer: boolean;
  readonly powerShellCandidates: ReadonlyArray<string>;
  readonly windowsPathExtensions: ReadonlyArray<string>;
}

interface LaunchPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly wait: boolean;
  readonly allowNonzeroExitCode: boolean;
  readonly detached?: boolean;
  readonly shell?: boolean;
  readonly stdio?: "ignore";
}

interface ResolvedCommand {
  readonly path: string;
  readonly usesCmdWrapper: boolean;
}

interface OpenApplicationCandidate {
  readonly name: string;
  readonly arguments: ReadonlyArray<string>;
}

interface LaunchAttemptFailure {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly reason: "commandNotFound" | "spawnFailed" | "nonZeroExit";
  readonly detail: string;
  readonly exitCode?: number;
}

type LaunchAttemptError =
  | DesktopLauncherCommandNotFoundError
  | DesktopLauncherNonZeroExitError
  | DesktopLauncherSpawnError;

type LaunchPlanError = LaunchAttemptError | DesktopLauncherLaunchAttemptsExhaustedError;

const LINE_COLUMN_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const WINDOWS_POWERSHELL_CANDIDATES = ["powershell.exe", "powershell", "pwsh.exe", "pwsh"] as const;
const WSL_POWERSHELL_CANDIDATES = [
  "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
  "powershell.exe",
  "pwsh.exe",
] as const;
const WINDOWS_EDITOR_URI_SCHEMES: Partial<Record<EditorId, string>> = {
  vscode: "vscode",
  "vscode-insiders": "vscode-insiders",
  vscodium: "vscodium",
};

function shouldUseGotoFlag(editor: (typeof EDITORS)[number], target: string): boolean {
  return editor.supportsGoto && LINE_COLUMN_SUFFIX_PATTERN.test(target);
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function splitLineColumnSuffix(target: string): {
  readonly filePath: string;
  readonly suffix: string;
} {
  const match = target.match(LINE_COLUMN_SUFFIX_PATTERN);
  if (!match) {
    return {
      filePath: target,
      suffix: "",
    };
  }

  return {
    filePath: target.slice(0, -match[0].length),
    suffix: match[0],
  };
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;

  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));

  return parsed.length > 0 ? Array.dedupe(parsed) : fallback;
}

function resolveCommandCandidates(
  command: string,
  runtime: LaunchRuntime,
  pathService: Path.Path,
): ReadonlyArray<string> {
  if (runtime.platform !== "win32") return [command];
  const extension = pathService.extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && runtime.windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);
    return Array.dedupe([
      command,
      `${commandWithoutExtension}${normalizedExtension}`,
      `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
    ]);
  }

  const candidates: string[] = [];
  for (const extensionName of runtime.windowsPathExtensions) {
    candidates.push(`${command}${extensionName}`);
    candidates.push(`${command}${extensionName.toLowerCase()}`);
  }
  return Array.dedupe(candidates);
}

function resolvePathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function detectWsl(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform !== "linux") return false;
  if (typeof env.WSL_DISTRO_NAME === "string" || typeof env.WSL_INTEROP === "string") {
    return true;
  }
  return OS.release().toLowerCase().includes("microsoft");
}

function quotePowerShellValue(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quotePowerShellArgument(value: string): string {
  return `"\`"${value.replaceAll("`", "``").replaceAll('"', '`"')}\`""`;
}

function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
}

function normalizeAppCandidates(
  app: OpenApplicationInput | ReadonlyArray<OpenApplicationInput> | undefined,
): ReadonlyArray<OpenApplicationCandidate | undefined> {
  if (!app) return [undefined];

  const apps = Array.ensure(app);
  const candidates: Array<OpenApplicationCandidate> = [];

  for (const appDef of apps) {
    const names = Array.ensure(appDef.name);
    for (const name of names) {
      candidates.push({ name, arguments: appDef.arguments ?? [] });
    }
  }

  return candidates.length > 0 ? candidates : [undefined];
}

function isUriLikeTarget(target: string): boolean {
  return /^[A-Za-z][A-Za-z\d+.-]*:/.test(target);
}

function shouldPreferWindowsOpenerOnWsl(input: OpenExternalInput, runtime: LaunchRuntime): boolean {
  return runtime.isWsl && !runtime.isInsideContainer && isUriLikeTarget(input.target);
}

function makeWindowsEditorProtocolTarget(editor: EditorId, target: string): string | undefined {
  const scheme = WINDOWS_EDITOR_URI_SCHEMES[editor];
  if (!scheme) return undefined;

  const { filePath, suffix } = splitLineColumnSuffix(target);
  const fileUrl = pathToFileURL(filePath).href;
  const fileTarget = fileUrl.startsWith("file:///")
    ? fileUrl.slice("file:///".length)
    : fileUrl.replace(/^file:\/\//, "");

  return `${scheme}://file/${fileTarget}${suffix}`;
}

function makeLaunchPlan(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly wait: boolean;
    readonly allowNonzeroExitCode: boolean;
    readonly detached?: boolean;
    readonly shell?: boolean;
    readonly stdio?: "ignore";
  },
): LaunchPlan {
  return {
    command,
    args,
    wait: options.wait,
    allowNonzeroExitCode: options.allowNonzeroExitCode,
    shell: options.shell ?? false,
    ...(options.detached !== undefined ? { detached: options.detached } : {}),
    ...(options.stdio !== undefined ? { stdio: options.stdio } : {}),
  };
}

function makeDarwinDefaultPlan(input: OpenExternalInput): LaunchPlan {
  const args: string[] = [];
  const wait = input.wait ?? false;

  if (wait) args.push("--wait-apps");
  if (input.background) args.push("--background");
  if (input.newInstance) args.push("--new");
  args.push(input.target);

  return makeLaunchPlan("open", args, {
    wait,
    allowNonzeroExitCode: input.allowNonzeroExitCode ?? false,
    shell: false,
  });
}

function makeDarwinApplicationPlan(
  input: OpenExternalInput,
  app: OpenApplicationCandidate,
): LaunchPlan {
  const args: string[] = [];
  const wait = input.wait ?? false;

  if (wait) args.push("--wait-apps");
  if (input.background) args.push("--background");
  if (input.newInstance) args.push("--new");
  args.push("-a", app.name);
  args.push(input.target);
  if (app.arguments.length > 0) {
    args.push("--args", ...app.arguments);
  }

  return makeLaunchPlan("open", args, {
    wait,
    allowNonzeroExitCode: input.allowNonzeroExitCode ?? false,
    shell: false,
  });
}

function makePowerShellPlan(input: OpenExternalInput, powerShellCommand: string): LaunchPlan {
  const encodedParts = ["Start"];
  const wait = input.wait ?? false;

  if (wait) encodedParts.push("-Wait");
  encodedParts.push(quotePowerShellValue(input.target));

  return makeLaunchPlan(
    powerShellCommand,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShellCommand(encodedParts.join(" ")),
    ],
    {
      wait,
      allowNonzeroExitCode: input.allowNonzeroExitCode ?? false,
      shell: false,
    },
  );
}

function makePowerShellStartProcessArgs(
  commandPath: string,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const argumentList =
    args.length > 0 ? ` -ArgumentList ${args.map(quotePowerShellArgument).join(",")}` : "";
  const command = `Start ${quotePowerShellArgument(commandPath)}${argumentList} -WindowStyle Hidden`;
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodePowerShellCommand(command),
  ];
}

function makeLinuxDefaultPlan(input: OpenExternalInput): LaunchPlan {
  const wait = input.wait ?? false;
  return makeLaunchPlan("xdg-open", [input.target], {
    wait,
    allowNonzeroExitCode: input.allowNonzeroExitCode ?? false,
    detached: !wait,
    ...(wait ? {} : { stdio: "ignore" as const }),
    shell: false,
  });
}

function makeWindowsExplorerPlan(input: OpenExternalInput): LaunchPlan {
  return makeLaunchPlan("explorer", [input.target], {
    wait: false,
    allowNonzeroExitCode: false,
    detached: true,
    stdio: "ignore",
    shell: false,
  });
}

function makeDirectApplicationPlan(
  input: OpenExternalInput,
  app: OpenApplicationCandidate,
): LaunchPlan {
  const wait = input.wait ?? false;
  return makeLaunchPlan(app.name, [...app.arguments, input.target], {
    wait,
    allowNonzeroExitCode: input.allowNonzeroExitCode ?? false,
    detached: !wait,
    ...(wait ? {} : { stdio: "ignore" as const }),
    shell: false,
  });
}

function resolveExternalPlans(
  input: OpenExternalInput,
  runtime: LaunchRuntime,
): ReadonlyArray<LaunchPlan> {
  const appCandidates = normalizeAppCandidates(input.app);
  const plans: LaunchPlan[] = [];
  const preferWindowsOpenerOnWsl = shouldPreferWindowsOpenerOnWsl(input, runtime);

  for (const app of appCandidates) {
    if (app) {
      if (runtime.platform === "darwin") {
        plans.push(makeDarwinApplicationPlan(input, app));
      } else {
        plans.push(makeDirectApplicationPlan(input, app));
      }
      continue;
    }

    if (runtime.platform === "darwin") {
      plans.push(makeDarwinDefaultPlan(input));
      continue;
    }

    if (runtime.platform === "win32" || preferWindowsOpenerOnWsl) {
      for (const powerShellCommand of runtime.powerShellCandidates) {
        plans.push(makePowerShellPlan(input, powerShellCommand));
      }
    }

    if (runtime.platform === "win32") {
      if (!(input.wait ?? false)) {
        plans.push(makeWindowsExplorerPlan(input));
      }
      continue;
    }

    plans.push(makeLinuxDefaultPlan(input));
  }

  return plans;
}

function resolveSpawnInput(
  runtime: LaunchRuntime,
  plan: LaunchPlan,
  resolvedCommand: ResolvedCommand,
  startProcessLauncher: string | undefined,
): DetachedSpawnInput {
  if (plan.detached && resolvedCommand.usesCmdWrapper && startProcessLauncher !== undefined) {
    return {
      command: startProcessLauncher,
      args: makePowerShellStartProcessArgs(resolvedCommand.path, plan.args),
      ...(plan.detached !== undefined ? { detached: plan.detached } : {}),
      ...(plan.shell !== undefined ? { shell: plan.shell } : {}),
      ...(runtime.platform === "win32"
        ? { windowsVerbatimArguments: true, windowsHide: true }
        : {}),
      ...(plan.stdio === "ignore"
        ? {
            stdin: "ignore" as const,
            stdout: "ignore" as const,
            stderr: "ignore" as const,
          }
        : {}),
    };
  }
  const windowsHide = runtime.platform === "win32" && plan.detached ? true : undefined;
  return {
    command: resolvedCommand.usesCmdWrapper
      ? resolveWindowsCommandShell(runtime.env)
      : resolvedCommand.path,
    args: resolvedCommand.usesCmdWrapper
      ? makeWindowsCmdSpawnArguments(resolvedCommand.path, plan.args)
      : [...plan.args],
    ...(plan.detached !== undefined ? { detached: plan.detached } : {}),
    ...(plan.shell !== undefined ? { shell: plan.shell } : {}),
    ...(windowsHide ? { windowsHide } : {}),
    ...(resolvedCommand.usesCmdWrapper ? { windowsVerbatimArguments: true } : {}),
    ...(plan.stdio === "ignore"
      ? {
          stdin: "ignore" as const,
          stdout: "ignore" as const,
          stderr: "ignore" as const,
        }
      : {}),
  };
}

function makeCommandNotFoundError(
  context: LaunchContext,
  command: string,
): DesktopLauncherCommandNotFoundError {
  return new DesktopLauncherCommandNotFoundError({
    operation: context.operation,
    command,
    ...(context.target !== undefined ? { target: context.target } : {}),
    ...(context.editor !== undefined ? { editor: context.editor } : {}),
  });
}

function makeSpawnError(
  context: LaunchContext,
  command: string,
  args: ReadonlyArray<string>,
  cause?: unknown,
): DesktopLauncherSpawnError {
  return new DesktopLauncherSpawnError({
    operation: context.operation,
    command,
    args: [...args],
    ...(context.target !== undefined ? { target: context.target } : {}),
    ...(context.editor !== undefined ? { editor: context.editor } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
}

function makeNonZeroExitError(
  context: LaunchContext,
  command: string,
  args: ReadonlyArray<string>,
  exitCode: number,
): DesktopLauncherNonZeroExitError {
  return new DesktopLauncherNonZeroExitError({
    operation: context.operation,
    command,
    args: [...args],
    exitCode,
    ...(context.target !== undefined ? { target: context.target } : {}),
    ...(context.editor !== undefined ? { editor: context.editor } : {}),
  });
}

function toLaunchAttemptFailure(error: LaunchAttemptError): LaunchAttemptFailure {
  switch (error._tag) {
    case "DesktopLauncherCommandNotFoundError":
      return {
        command: error.command,
        args: [],
        reason: "commandNotFound",
        detail: error.message,
      };
    case "DesktopLauncherSpawnError":
      return {
        command: error.command,
        args: error.args,
        reason: "spawnFailed",
        detail: error.message,
      };
    case "DesktopLauncherNonZeroExitError":
      return {
        command: error.command,
        args: error.args,
        reason: "nonZeroExit",
        detail: error.message,
        exitCode: error.exitCode,
      };
  }
}

/**
 * Detached GUI launches must call `unref()` after spawn. The Effect
 * `ChildProcessSpawner` owns spawned handles through scope finalizers and does
 * not expose `unref()`, which means it cannot provide true fire-and-forget
 * behavior for editor / file-manager launches.
 */
const DETACHED_SPAWN_GRACE_MS = 500;

function defaultSpawnDetached(
  input: DetachedSpawnInput,
  context: LaunchContext,
): Effect.Effect<void, DesktopLauncherSpawnError> {
  return Effect.try({
    try: () =>
      spawnNodeChildProcess(input.command, [...input.args], {
        ...(input.detached !== undefined ? { detached: input.detached } : {}),
        ...(input.shell !== undefined ? { shell: input.shell } : {}),
        ...(input.windowsHide !== undefined ? { windowsHide: input.windowsHide } : {}),
        ...(input.windowsVerbatimArguments !== undefined
          ? { windowsVerbatimArguments: input.windowsVerbatimArguments }
          : {}),
        ...(input.stdin === "ignore" && input.stdout === "ignore" && input.stderr === "ignore"
          ? { stdio: "ignore" as const }
          : {}),
      }),
    catch: (cause) => makeSpawnError(context, input.command, input.args, cause),
  }).pipe(
    Effect.flatMap((childProcess) =>
      Effect.callback<void, DesktopLauncherSpawnError>((resume) => {
        let graceTimer: ReturnType<typeof setTimeout> | undefined;

        const onEarlyExit = (code: number | null) => {
          if (graceTimer !== undefined) clearTimeout(graceTimer);
          if (code !== null && code !== 0) {
            resume(
              Effect.fail(
                makeSpawnError(
                  context,
                  input.command,
                  input.args,
                  new Error(`Process exited immediately with code ${code}`),
                ),
              ),
            );
          } else {
            childProcess.unref();
            resume(Effect.void);
          }
        };

        const onError = (error: Error) => {
          childProcess.off("spawn", onSpawn);
          resume(Effect.fail(makeSpawnError(context, input.command, input.args, error)));
        };

        const onSpawn = () => {
          childProcess.off("error", onError);
          childProcess.once("exit", onEarlyExit);
          graceTimer = setTimeout(() => {
            childProcess.off("exit", onEarlyExit);
            childProcess.unref();
            resume(Effect.void);
          }, DETACHED_SPAWN_GRACE_MS);
        };

        childProcess.once("error", onError);
        childProcess.once("spawn", onSpawn);

        return Effect.sync(() => {
          if (graceTimer !== undefined) clearTimeout(graceTimer);
          childProcess.off("error", onError);
          childProcess.off("spawn", onSpawn);
          childProcess.off("exit", onEarlyExit);
        });
      }),
    ),
  );
}

export const make = Effect.fn("makeDesktopLauncher")(function* (
  options: LaunchRuntimeOptions = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeEnv = options.env ?? process.env;
  const runtimePlatform = options.platform ?? process.platform;
  const isWsl = options.isWsl ?? detectWsl(runtimePlatform, runtimeEnv);

  const isInsideContainer =
    options.isInsideContainer ??
    (typeof runtimeEnv.CONTAINER === "string" ||
    typeof runtimeEnv.container === "string" ||
    typeof runtimeEnv.KUBERNETES_SERVICE_HOST === "string"
      ? true
      : yield* fileSystem.exists("/.dockerenv").pipe(Effect.catch(() => Effect.succeed(false))));

  const runtime: LaunchRuntime = {
    platform: runtimePlatform,
    env: runtimeEnv,
    isWsl,
    isInsideContainer,
    powerShellCandidates:
      options.powerShellCommand !== undefined
        ? [options.powerShellCommand]
        : isWsl
          ? WSL_POWERSHELL_CANDIDATES
          : WINDOWS_POWERSHELL_CANDIDATES,
    windowsPathExtensions: resolveWindowsPathExtensions(runtimeEnv),
  };

  const resolveCommand = Effect.fn("resolveCommand")(function* (
    command: string,
  ): Effect.fn.Return<Option.Option<ResolvedCommand>> {
    const candidates = resolveCommandCandidates(command, runtime, pathService);

    const resolveExecutableFile = Effect.fn("resolveExecutableFile")(function* (
      filePath: string,
    ): Effect.fn.Return<Option.Option<ResolvedCommand>> {
      const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") return Option.none();

      if (runtime.platform === "win32") {
        const extension = pathService.extname(filePath);
        if (
          extension.length === 0 ||
          !runtime.windowsPathExtensions.includes(extension.toUpperCase())
        ) {
          return Option.none();
        }

        return Option.some({
          path: filePath,
          usesCmdWrapper: isWindowsBatchShim(filePath),
        } satisfies ResolvedCommand);
      }

      return (info.value.mode & 0o111) !== 0
        ? Option.some({
            path: filePath,
            usesCmdWrapper: false,
          } satisfies ResolvedCommand)
        : Option.none();
    });

    if (command.includes("/") || command.includes("\\")) {
      for (const candidate of candidates) {
        const resolved = yield* resolveExecutableFile(candidate);
        if (Option.isSome(resolved)) return resolved;
      }
      return Option.none();
    }

    const pathValue = resolvePathEnvironmentVariable(runtime.env);
    if (pathValue.length === 0) return Option.none();

    const pathEntries = pathValue
      .split(resolvePathDelimiter(runtime.platform))
      .map((entry) => stripWrappingQuotes(entry.trim()))
      .filter((entry) => entry.length > 0);

    for (const pathEntry of pathEntries) {
      for (const candidate of candidates) {
        const resolved = yield* resolveExecutableFile(pathService.join(pathEntry, candidate));
        if (Option.isSome(resolved)) {
          return resolved;
        }
      }
    }

    return Option.none();
  });

  const commandAvailable = (command: string) =>
    resolveCommand(command).pipe(Effect.map(Option.isSome));

  const startProcessLauncher = yield* Effect.gen(function* () {
    for (const candidate of runtime.powerShellCandidates) {
      const resolved = yield* resolveCommand(candidate);
      if (Option.isSome(resolved)) {
        return resolved.value.path;
      }
    }
    return undefined;
  });

  const fileManagerAvailable = Effect.gen(function* () {
    const candidates =
      runtime.platform === "darwin"
        ? ["open"]
        : runtime.platform === "win32"
          ? [...runtime.powerShellCandidates, "explorer"]
          : ["xdg-open"];

    for (const candidate of candidates) {
      if (yield* commandAvailable(candidate)) {
        return true;
      }
    }

    return false;
  });

  const getAvailableEditors: DesktopLauncherShape["getAvailableEditors"] = Effect.gen(function* () {
    const available: EditorId[] = [];

    for (const editor of EDITORS) {
      if (editor.id === "file-manager") {
        if (yield* fileManagerAvailable) {
          available.push(editor.id);
        }
        continue;
      }

      if (editor.command && (yield* commandAvailable(editor.command))) {
        available.push(editor.id);
      }
    }

    return available;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopLauncherDiscoveryError({
          operation: "getAvailableEditors",
          detail: "failed to resolve available editors",
          cause,
        }),
    ),
  );

  const spawnPlan = (
    plan: LaunchPlan,
    resolvedCommand: ResolvedCommand,
    context: LaunchContext,
  ) => {
    const input = resolveSpawnInput(runtime, plan, resolvedCommand, startProcessLauncher);
    return spawner
      .spawn(
        ChildProcess.make(input.command, [...input.args], {
          detached: plan.detached,
          shell: plan.shell,
          ...(plan.stdio === "ignore"
            ? {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              }
            : {}),
        }),
      )
      .pipe(Effect.mapError((cause) => makeSpawnError(context, input.command, input.args, cause)));
  };

  const spawnDetached = options.spawnDetached ?? defaultSpawnDetached;

  const waitForExit = (
    plan: LaunchPlan,
    context: LaunchContext,
    spawnInput: DetachedSpawnInput,
    handle: ChildProcessSpawner.ChildProcessHandle,
  ) =>
    handle.exitCode.pipe(
      Effect.mapError((cause) =>
        makeSpawnError(context, spawnInput.command, spawnInput.args, cause),
      ),
      Effect.flatMap((exitCode) =>
        !plan.allowNonzeroExitCode && exitCode !== 0
          ? Effect.fail(
              makeNonZeroExitError(context, spawnInput.command, spawnInput.args, exitCode),
            )
          : Effect.void,
      ),
    );

  const runWaitedPlan = (
    plan: LaunchPlan,
    resolvedCommand: ResolvedCommand,
    context: LaunchContext,
  ) =>
    Effect.acquireUseRelease(
      Scope.make("sequential"),
      (scope) =>
        Effect.gen(function* () {
          const spawnInput = resolveSpawnInput(
            runtime,
            plan,
            resolvedCommand,
            startProcessLauncher,
          );
          const handle = yield* spawnPlan(plan, resolvedCommand, context).pipe(
            Scope.provide(scope),
          );
          yield* waitForExit(plan, context, spawnInput, handle);
        }),
      (scope, exit) => Scope.close(scope, exit),
    );

  const runDetachedPlan = (
    plan: LaunchPlan,
    resolvedCommand: ResolvedCommand,
    context: LaunchContext,
  ) =>
    spawnDetached(resolveSpawnInput(runtime, plan, resolvedCommand, startProcessLauncher), context);

  const runPlan = (plan: LaunchPlan, resolvedCommand: ResolvedCommand, context: LaunchContext) =>
    plan.wait
      ? runWaitedPlan(plan, resolvedCommand, context)
      : runDetachedPlan(plan, resolvedCommand, context);

  const runFirstAvailablePlan = Effect.fn("runFirstAvailablePlan")(function* (
    plans: ReadonlyArray<LaunchPlan>,
    context: LaunchContext,
  ): Effect.fn.Return<void, LaunchPlanError> {
    const failures: LaunchAttemptError[] = [];

    for (const plan of plans) {
      const resolvedCommand = yield* resolveCommand(plan.command);
      if (Option.isNone(resolvedCommand)) {
        failures.push(makeCommandNotFoundError(context, plan.command));
        continue;
      }

      const attempt = yield* Effect.result(runPlan(plan, resolvedCommand.value, context));
      if (attempt._tag === "Success") {
        return;
      }

      failures.push(attempt.failure);
    }

    const [firstFailure] = failures;
    if (failures.length === 1 && firstFailure) {
      return yield* firstFailure;
    }

    return yield* new DesktopLauncherLaunchAttemptsExhaustedError({
      operation: context.operation,
      ...(context.target !== undefined ? { target: context.target } : {}),
      ...(context.editor !== undefined ? { editor: context.editor } : {}),
      attempts: failures.map(toLaunchAttemptFailure),
    });
  });

  const openTarget = Effect.fn("openTarget")(function* (
    operation: Extract<DesktopLauncherOperation, "openBrowser" | "openExternal" | "openInEditor">,
    input: OpenExternalInput,
    context: Omit<LaunchContext, "operation"> = {},
  ) {
    if (input.target.trim().length === 0) {
      return yield* new DesktopLauncherValidationError({
        operation,
        detail: "target must not be empty",
        target: input.target,
      });
    }

    return yield* runFirstAvailablePlan(resolveExternalPlans(input, runtime), {
      operation,
      target: input.target,
      ...(context.editor !== undefined ? { editor: context.editor } : {}),
    });
  });

  const openExternal: DesktopLauncherShape["openExternal"] = Effect.fn("openExternal")(
    function* (input) {
      return yield* openTarget("openExternal", input);
    },
  );

  const openBrowser: DesktopLauncherShape["openBrowser"] = Effect.fn("openBrowser")(function* (
    target,
    openOptions = {},
  ) {
    return yield* openTarget("openBrowser", { ...openOptions, target });
  });

  const openInEditor: DesktopLauncherShape["openInEditor"] = Effect.fn("openInEditor")(
    function* (input) {
      const editor = EDITORS.find((candidate) => candidate.id === input.editor);
      if (!editor) {
        return yield* new DesktopLauncherUnknownEditorError({ editor: input.editor });
      }

      const windowsEditorProtocolTarget =
        runtime.platform === "win32"
          ? makeWindowsEditorProtocolTarget(input.editor, input.cwd)
          : undefined;
      if (windowsEditorProtocolTarget) {
        return yield* runFirstAvailablePlan(
          [makeWindowsExplorerPlan({ target: windowsEditorProtocolTarget })],
          {
            operation: "openInEditor",
            target: input.cwd,
            editor: input.editor,
          },
        );
      }

      if (editor.command) {
        return yield* runFirstAvailablePlan(
          [
            makeLaunchPlan(
              editor.command,
              shouldUseGotoFlag(editor, input.cwd) ? ["--goto", input.cwd] : [input.cwd],
              {
                wait: false,
                allowNonzeroExitCode: false,
                detached: true,
                stdio: "ignore",
                shell: false,
              },
            ),
          ],
          {
            operation: "openInEditor",
            target: input.cwd,
            editor: input.editor,
          },
        );
      }

      return yield* openTarget(
        "openInEditor",
        { target: input.cwd },
        { target: input.cwd, editor: input.editor },
      );
    },
  );

  return {
    getAvailableEditors,
    openExternal,
    openBrowser,
    openInEditor,
  } satisfies DesktopLauncherShape;
});

export const layer = Layer.effect(DesktopLauncher, make());
