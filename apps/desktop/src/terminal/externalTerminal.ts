import { EXTERNAL_TERMINALS, type OpenExternalTerminalInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { isCommandAvailable } from "@t3tools/shared/shell";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const appleString = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** Keep paths and SSH destinations as data across each shell/AppleScript boundary. */
export function terminalLaunch(input: OpenExternalTerminalInput, platform: string) {
  if (
    // oxlint-disable-next-line no-control-regex -- Control characters cannot be passed safely through terminal scripting.
    /[\x00-\x1f\x7f]/.test(input.cwd) ||
    (input.sshHost && !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]*$/.test(input.sshHost))
  ) {
    throw new Error("Invalid terminal directory or SSH host.");
  }
  if (input.sshHost && input.wslDistro) throw new Error("Choose either SSH or WSL.");
  const terminal =
    input.terminal === "system"
      ? platform === "darwin"
        ? "terminal"
        : platform === "win32"
          ? "windows-terminal"
          : "system"
      : input.terminal;
  if (!EXTERNAL_TERMINALS.find(({ id }) => id === terminal)?.platforms.includes(platform)) {
    throw new Error("This terminal is not supported on this platform.");
  }
  const remoteCommand = `cd ${quote(input.cwd)} && exec "\${SHELL:-/bin/sh}" -l`;
  const session = input.sshHost
    ? ["ssh", "-t", "--", input.sshHost, `/bin/sh -c ${quote(remoteCommand)}`]
    : input.wslDistro
      ? ["wsl.exe", "--distribution", input.wslDistro, "--cd", input.cwd]
      : null;
  const command = session ? session.map(quote).join(" ") : remoteCommand;
  if (terminal === "terminal" || terminal === "iterm2") {
    // Execute via /bin/sh so the terminal's configured shell need not be POSIX.
    const shellCommand = `/bin/sh -c ${quote(command)}`;
    const script =
      terminal === "terminal"
        ? `tell application "Terminal"\nactivate\ndo script ${appleString(shellCommand)}\nend tell`
        : `tell application "iTerm2"\nactivate\ncreate window with default profile command ${appleString(shellCommand)}\nend tell`;
    return { file: "/usr/bin/osascript", args: ["-e", script], wait: true };
  }
  if (terminal === "windows-terminal") {
    // Encode the PowerShell payload: WT interprets semicolons even inside arguments.
    const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    // Start-Process takes a Windows command line, avoiding Windows PowerShell
    // 5.1's native argument marshalling, which strips embedded double quotes.
    const windowsQuote = (value: string) =>
      `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
    const script = session
      ? `Start-Process -FilePath ${psQuote(session[0]!)} -ArgumentList ${psQuote(session.slice(1).map(windowsQuote).join(" "))} -NoNewWindow -Wait`
      : `Set-Location -LiteralPath ${psQuote(input.cwd)}`;
    return {
      file: "wt.exe",
      args: [
        "-w",
        "new",
        "new-tab",
        "powershell.exe",
        "-NoExit",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      wait: true,
    };
  }
  if (input.wslDistro) throw new Error("WSL terminals require Windows Terminal.");
  const child = session ?? ["/bin/sh", "-c", remoteCommand];
  switch (terminal) {
    case "ghostty":
      return platform === "darwin"
        ? { file: "/usr/bin/open", args: ["-na", "Ghostty", "--args", "-e", ...child], wait: true }
        : { file: "ghostty", args: ["-e", ...child], wait: false };
    case "gnome-terminal":
      return { file: "gnome-terminal", args: ["--", ...child], wait: true };
    case "konsole":
      return { file: "konsole", args: ["--separate", "-e", ...child], wait: false };
    default:
      return {
        file: terminal === "system" ? "x-terminal-emulator" : "xterm",
        args: ["-e", ...child],
        wait: false,
      };
  }
}

export class TerminalLaunchError extends Schema.TaggedError<TerminalLaunchError>()(
  "TerminalLaunchError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Could not open the terminal. Check that the selected app is installed and SSH is configured.";
  }
}

export const launchExternalTerminal = Effect.fn("desktop.launchExternalTerminal")(
  function* (input: OpenExternalTerminalInput, platform: string) {
    let resolved = input;
    if (
      platform === "linux" &&
      input.terminal === "system" &&
      !(yield* isCommandAvailable("x-terminal-emulator"))
    ) {
      for (const terminal of ["gnome-terminal", "konsole", "ghostty", "xterm"] as const) {
        if (yield* isCommandAvailable(terminal)) {
          resolved = { ...input, terminal };
          break;
        }
      }
    }
    const launch = yield* Effect.try({
      try: () => terminalLaunch(resolved, platform),
      catch: (cause) => new TerminalLaunchError({ cause }),
    });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(launch.file, launch.args, {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    if (launch.wait) {
      const exitCode = yield* child.exitCode.pipe(Effect.timeout("30 seconds"));
      if (exitCode !== 0)
        return yield* new TerminalLaunchError({
          cause: `Terminal launcher exited with code ${exitCode}.`,
        });
    } else {
      // Native windows must outlive the IPC request and the desktop process.
      yield* child.unref.pipe(Effect.asVoid);
    }
  },
  Effect.scoped,
  Effect.mapError((cause) => new TerminalLaunchError({ cause })),
);
