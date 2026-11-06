import {
  buildRemoteSshTerminalDestination,
  buildRemoteSshTerminalRemoteCommand,
  remoteTerminalWorkingDirectory,
  type DesktopOpenRemoteTerminalInput,
} from "@t3tools/contracts";
import { resolveSshCommand } from "@t3tools/ssh/command";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const LINUX_TERMINAL_COMMANDS = [
  "xdg-terminal-exec",
  "x-terminal-emulator",
  "gnome-terminal",
  "kgx",
  "konsole",
  "xfce4-terminal",
  "kitty",
  "alacritty",
  "foot",
  "xterm",
] as const;

const DETACHED_IGNORE_STDIO = {
  detached: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
} as const;

const quoteSh = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const escapeAppleScriptString = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

/** wt.exe treats `;` as a command separator even inside quoted argv. */
const escapeWindowsTerminalArg = (value: string): string => value.replaceAll(";", "\\;");

/** cmd.exe expands `%NAME%` in the /c string before start runs. */
const escapeCmdPercent = (value: string): string => value.replaceAll("%", "%%");

export const windowsTerminalRemoteArgs = (
  sshCommand: string,
  sshArgs: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  // `-w -1` opens a new window; `-w 0` would reuse the last focused window.
  "-w",
  "-1",
  "nt",
  "--",
  escapeWindowsTerminalArg(sshCommand),
  ...sshArgs.map(escapeWindowsTerminalArg),
];

export const cmdStartRemoteArgs = (
  sshCommand: string,
  sshArgs: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  "/c",
  "start",
  "",
  escapeCmdPercent(sshCommand),
  ...sshArgs.map(escapeCmdPercent),
];

const launchAndUnref = Effect.fn("desktop.openRemoteTerminal.launchAndUnref")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.CommandOptions = DETACHED_IGNORE_STDIO,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* spawner.spawn(ChildProcess.make(command, args, options)).pipe(
    Effect.flatMap((handle) => handle.unref),
    Effect.asVoid,
    Effect.scoped,
  );
});

export const linuxRemoteTerminalArgs = (
  command: string,
  sshCommand: string,
  sshArgs: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  switch (command) {
    case "gnome-terminal":
    case "kgx":
      return ["--", sshCommand, ...sshArgs];
    case "xfce4-terminal":
      // `--` only ends Xfce options; `-x` is required to run a command.
      return ["-x", sshCommand, ...sshArgs];
    default:
      return ["-e", sshCommand, ...sshArgs];
  }
};

const resolveLinuxTerminalCommand = Effect.fn("desktop.openRemoteTerminal.resolveLinuxTerminal")(
  function* (env: NodeJS.ProcessEnv) {
    for (const command of LINUX_TERMINAL_COMMANDS) {
      if (yield* isCommandAvailable(command, { env })) return command;
    }
    return undefined;
  },
);

const launchDarwin = Effect.fn("desktop.openRemoteTerminal.launchDarwin")(function* (
  sshCommand: string,
  sshArgs: ReadonlyArray<string>,
) {
  const shellLine = [sshCommand, ...sshArgs].map(quoteSh).join(" ");
  yield* launchAndUnref("osascript", [
    "-e",
    `tell application "Terminal" to do script "${escapeAppleScriptString(shellLine)}"`,
    "-e",
    'tell application "Terminal" to activate',
  ]);
});

const launchWindows = Effect.fn("desktop.openRemoteTerminal.launchWindows")(function* (
  sshCommand: string,
  sshArgs: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) {
  if (yield* isCommandAvailable("wt.exe", { env })) {
    yield* launchAndUnref("wt.exe", windowsTerminalRemoteArgs(sshCommand, sshArgs));
    return;
  }
  // `start`'s first quoted token is the window title; keep it empty so ssh is the command.
  yield* launchAndUnref("cmd.exe", cmdStartRemoteArgs(sshCommand, sshArgs), {
    ...DETACHED_IGNORE_STDIO,
    shell: false,
  });
});

const launchLinux = Effect.fn("desktop.openRemoteTerminal.launchLinux")(function* (
  sshCommand: string,
  sshArgs: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) {
  const terminal = yield* resolveLinuxTerminalCommand(env);
  if (terminal === undefined) return false;
  yield* launchAndUnref(terminal, linuxRemoteTerminalArgs(terminal, sshCommand, sshArgs));
  return true;
});

/** Spawns a local system terminal that SSHs to the remote working directory. */
export const openRemoteTerminal = Effect.fn("desktop.openRemoteTerminal")(function* (
  input: DesktopOpenRemoteTerminalInput,
) {
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;
  const directory = remoteTerminalWorkingDirectory(input.absolutePath, input.isFile === true);
  const destination = buildRemoteSshTerminalDestination(input.host, input.username);
  const remoteCommand = buildRemoteSshTerminalRemoteCommand(directory);
  const sshCommand = yield* resolveSshCommand;
  // `--` ends option parsing so a destination that starts with `-` stays a hostname.
  const sshArgs = ["-t", "--", destination, remoteCommand] as const;

  if (platform === "linux") {
    return yield* launchLinux(sshCommand, sshArgs, env).pipe(Effect.orElseSucceed(() => false));
  }

  return yield* (
    platform === "darwin"
      ? launchDarwin(sshCommand, sshArgs)
      : launchWindows(sshCommand, sshArgs, env)
  ).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});
