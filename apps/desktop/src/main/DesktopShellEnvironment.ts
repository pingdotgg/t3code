import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

type EnvironmentPatch = Record<string, string>;

interface ShellEnvironmentConfig {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly userShell: Option.Option<string>;
}

interface WindowsProbeOptions {
  readonly loadProfile: boolean;
}

interface ShellProbe {
  readonly readLoginShellEnvironment: (
    shell: string,
    names: ReadonlyArray<string>,
  ) => Effect.Effect<EnvironmentPatch, unknown>;
  readonly readLaunchctlPath: Effect.Effect<Option.Option<string>, unknown>;
  readonly readWindowsEnvironment: (
    names: ReadonlyArray<string>,
    options: WindowsProbeOptions,
  ) => Effect.Effect<EnvironmentPatch, unknown>;
}

export interface DesktopShellEnvironmentShape {
  readonly installIntoProcess: Effect.Effect<void>;
}

export class DesktopShellEnvironment extends Context.Service<
  DesktopShellEnvironment,
  DesktopShellEnvironmentShape
>()("t3/desktop/ShellEnvironment") {}

const LOGIN_SHELL_ENV_NAMES = [
  "PATH",
  "SSH_AUTH_SOCK",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;
const WINDOWS_PROFILE_ENV_NAMES = ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"] as const;
const WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe"] as const;
const LOGIN_SHELL_TIMEOUT = Duration.seconds(5);
const LAUNCHCTL_TIMEOUT = Duration.seconds(2);
const PROCESS_TERMINATE_GRACE = Duration.seconds(1);

const noneProbe: ShellProbe = {
  readLoginShellEnvironment: () => Effect.succeed({}),
  readLaunchctlPath: Effect.succeed(Option.none<string>()),
  readWindowsEnvironment: () => Effect.succeed({}),
};

const trimNonEmpty = (value: string | null | undefined): Option.Option<string> =>
  Option.fromNullishOr(value).pipe(
    Option.map((entry) => entry.trim()),
    Option.filter((entry) => entry.length > 0),
  );

const pathDelimiter = (platform: NodeJS.Platform) => (platform === "win32" ? ";" : ":");

const readEnvPath = (env: NodeJS.ProcessEnv): Option.Option<string> =>
  trimNonEmpty(env.PATH ?? env.Path ?? env.path);

const pathComparisonKey = (entry: string, platform: NodeJS.Platform) => {
  const normalized = entry.trim().replace(/^"+|"+$/g, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
};

const mergePaths = (
  platform: NodeJS.Platform,
  values: ReadonlyArray<Option.Option<string>>,
): Option.Option<string> => {
  const delimiter = pathDelimiter(platform);
  const entries: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (Option.isNone(value)) continue;

    for (const entry of value.value.split(delimiter)) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;

      const key = pathComparisonKey(trimmed, platform);
      if (key.length === 0 || seen.has(key)) continue;

      seen.add(key);
      entries.push(trimmed);
    }
  }

  return entries.length > 0 ? Option.some(entries.join(delimiter)) : Option.none();
};

const listLoginShellCandidates = (config: ShellEnvironmentConfig): ReadonlyArray<string> => {
  const fallback =
    config.platform === "darwin" ? "/bin/zsh" : config.platform === "linux" ? "/bin/bash" : "";
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const candidate of [
    trimNonEmpty(config.env.SHELL),
    config.userShell,
    trimNonEmpty(fallback),
  ]) {
    if (Option.isNone(candidate) || seen.has(candidate.value)) continue;
    seen.add(candidate.value);
    candidates.push(candidate.value);
  }

  return candidates;
};

const knownWindowsCliDirs = (env: NodeJS.ProcessEnv): ReadonlyArray<string> => [
  ...trimNonEmpty(env.APPDATA).pipe(
    Option.match({
      onNone: () => [],
      onSome: (value) => [`${value}\\npm`],
    }),
  ),
  ...trimNonEmpty(env.LOCALAPPDATA).pipe(
    Option.match({
      onNone: () => [],
      onSome: (value) => [`${value}\\Programs\\nodejs`, `${value}\\Volta\\bin`, `${value}\\pnpm`],
    }),
  ),
  ...trimNonEmpty(env.USERPROFILE).pipe(
    Option.match({
      onNone: () => [],
      onSome: (value) => [`${value}\\.bun\\bin`, `${value}\\scoop\\shims`],
    }),
  ),
];

const startMarker = (name: string) => `__T3CODE_ENV_${name}_START__`;
const endMarker = (name: string) => `__T3CODE_ENV_${name}_END__`;

const capturePosixEnvironmentCommand = (names: ReadonlyArray<string>) =>
  names
    .map((name) => {
      return [
        `printf '%s\\n' '${startMarker(name)}'`,
        `printenv ${name} || true`,
        `printf '%s\\n' '${endMarker(name)}'`,
      ].join("; ");
    })
    .join("; ");

const captureWindowsEnvironmentCommand = (names: ReadonlyArray<string>) =>
  [
    "$ErrorActionPreference = 'Stop'",
    ...names.flatMap((name) => {
      return [
        `Write-Output '${startMarker(name)}'`,
        `$value = [Environment]::GetEnvironmentVariable('${name}')`,
        "if ($null -ne $value -and $value.Length -gt 0) { Write-Output $value }",
        `Write-Output '${endMarker(name)}'`,
      ];
    }),
  ].join("; ");

const extractEnvironment = (output: string, names: ReadonlyArray<string>): EnvironmentPatch => {
  const environment: EnvironmentPatch = {};

  for (const name of names) {
    const start = output.indexOf(startMarker(name));
    if (start === -1) continue;

    const valueStart = start + startMarker(name).length;
    const end = output.indexOf(endMarker(name), valueStart);
    if (end === -1) continue;

    const value = output
      .slice(valueStart, end)
      .replace(/^\r?\n/, "")
      .replace(/\r?\n$/, "");
    if (value.length > 0) {
      environment[name] = value;
    }
  }

  return environment;
};

const runCommandOutput = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly timeout: Duration.Duration;
    readonly shell?: boolean;
  },
): Effect.Effect<string> =>
  spawner
    .string(
      ChildProcess.make(input.command, input.args, {
        shell: input.shell ?? false,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: PROCESS_TERMINATE_GRACE,
      }),
    )
    .pipe(
      Effect.timeoutOption(input.timeout),
      Effect.map(Option.getOrElse(() => "")),
      Effect.catch(() => Effect.succeed("")),
    );

const makeProcessProbe = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): ShellProbe => ({
  readLoginShellEnvironment: (shell, names) =>
    names.length === 0
      ? Effect.succeed({})
      : runCommandOutput(spawner, {
          command: shell,
          args: ["-ilc", capturePosixEnvironmentCommand(names)],
          timeout: LOGIN_SHELL_TIMEOUT,
        }).pipe(Effect.map((output) => extractEnvironment(output, names))),
  readLaunchctlPath: runCommandOutput(spawner, {
    command: "/bin/launchctl",
    args: ["getenv", "PATH"],
    timeout: LAUNCHCTL_TIMEOUT,
  }).pipe(Effect.map(trimNonEmpty)),
  readWindowsEnvironment: (names, options) => {
    if (names.length === 0) return Effect.succeed({});

    const args = [
      "-NoLogo",
      ...(options.loadProfile ? ([] as const) : (["-NoProfile"] as const)),
      "-NonInteractive",
      "-Command",
      captureWindowsEnvironmentCommand(names),
    ];

    return Effect.gen(function* () {
      for (const command of WINDOWS_SHELL_CANDIDATES) {
        const output = yield* runCommandOutput(spawner, {
          command,
          args,
          shell: true,
          timeout: LOGIN_SHELL_TIMEOUT,
        });
        const environment = extractEnvironment(output, names);
        if (Object.keys(environment).length > 0) {
          return environment;
        }
      }

      return {};
    });
  },
});

const readWindowsEnvironment = (
  probe: ShellProbe,
  names: ReadonlyArray<string>,
  options: WindowsProbeOptions,
): Effect.Effect<EnvironmentPatch> =>
  probe.readWindowsEnvironment(names, options).pipe(Effect.catch(() => Effect.succeed({})));

const installWindowsEnvironment = (
  config: ShellEnvironmentConfig,
  probe: ShellProbe,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const noProfile = yield* readWindowsEnvironment(probe, ["PATH"], { loadProfile: false });
    const profile = yield* readWindowsEnvironment(probe, WINDOWS_PROFILE_ENV_NAMES, {
      loadProfile: true,
    });
    const mergedPath = mergePaths("win32", [
      trimNonEmpty(profile.PATH),
      trimNonEmpty(knownWindowsCliDirs(config.env).join(";")),
      trimNonEmpty(noProfile.PATH),
      readEnvPath(config.env),
    ]);

    if (Option.isSome(mergedPath)) {
      config.env.PATH = mergedPath.value;
    }
    if (!config.env.FNM_DIR && profile.FNM_DIR) {
      config.env.FNM_DIR = profile.FNM_DIR;
    }
    if (!config.env.FNM_MULTISHELL_PATH && profile.FNM_MULTISHELL_PATH) {
      config.env.FNM_MULTISHELL_PATH = profile.FNM_MULTISHELL_PATH;
    }
  });

const installPosixEnvironment = (
  config: ShellEnvironmentConfig,
  probe: ShellProbe,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const shellEnvironment: EnvironmentPatch = {};

    for (const shell of listLoginShellCandidates(config)) {
      const result = yield* probe.readLoginShellEnvironment(shell, LOGIN_SHELL_ENV_NAMES).pipe(
        Effect.option,
        Effect.tap((environment) =>
          Option.isNone(environment)
            ? Effect.logWarning("failed to read login shell environment", { shell })
            : Effect.void,
        ),
      );

      if (Option.isSome(result)) {
        Object.assign(shellEnvironment, result.value);
        if (shellEnvironment.PATH) break;
      }
    }

    const launchctlPath =
      config.platform === "darwin" && !shellEnvironment.PATH
        ? yield* probe.readLaunchctlPath.pipe(
            Effect.catch(() => Effect.succeed(Option.none<string>())),
          )
        : Option.none<string>();
    const mergedPath = mergePaths(config.platform, [
      trimNonEmpty(shellEnvironment.PATH).pipe(Option.orElse(() => launchctlPath)),
      readEnvPath(config.env),
    ]);

    if (Option.isSome(mergedPath)) {
      config.env.PATH = mergedPath.value;
    }
    if (!config.env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      config.env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }

    for (const name of [
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ] as const) {
      if (!config.env[name] && shellEnvironment[name]) {
        config.env[name] = shellEnvironment[name];
      }
    }
  });

const installShellEnvironment = (
  config: ShellEnvironmentConfig,
  probe: ShellProbe,
): Effect.Effect<void> => {
  if (config.platform === "win32") {
    return installWindowsEnvironment(config, probe);
  }
  if (config.platform === "darwin" || config.platform === "linux") {
    return installPosixEnvironment(config, probe);
  }
  return Effect.void;
};

export const layer = Layer.effect(
  DesktopShellEnvironment,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return DesktopShellEnvironment.of({
      installIntoProcess: installShellEnvironment(
        {
          env: process.env,
          platform: environment.platform,
          userShell: Option.none(),
        },
        makeProcessProbe(spawner),
      ),
    });
  }),
);

export const layerTest = (input: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly userShell?: string;
  readonly probe?: {
    readonly readLoginShellEnvironment?: (
      shell: string,
      names: ReadonlyArray<string>,
    ) => Effect.Effect<EnvironmentPatch, unknown>;
    readonly readLaunchctlPath?: Effect.Effect<Option.Option<string>, unknown>;
    readonly readWindowsEnvironment?: (
      names: ReadonlyArray<string>,
      options: WindowsProbeOptions,
    ) => Effect.Effect<EnvironmentPatch, unknown>;
  };
}) => {
  const config: ShellEnvironmentConfig = {
    env: input.env,
    platform: input.platform,
    userShell: trimNonEmpty(input.userShell),
  };
  return Layer.succeed(
    DesktopShellEnvironment,
    DesktopShellEnvironment.of({
      installIntoProcess: installShellEnvironment(config, { ...noneProbe, ...input.probe }),
    }),
  );
};
