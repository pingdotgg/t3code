// @effect-diagnostics nodeBuiltinImport:off - Tests execute generated commands through a real POSIX shell in temporary directories.
import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { launchExternalTerminal, terminalLaunch } from "./externalTerminal.ts";

describe("external terminal launch", () => {
  it("opens the exact local directory without evaluating shell syntax in its name", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-terminal-"));
    try {
      const cwd = NodePath.join(root, "a 'quoted' $(touch INJECTED) ; folder");
      NodeFS.mkdirSync(cwd);
      const shell = NodePath.join(root, "login-shell");
      NodeFS.writeFileSync(shell, '#!/bin/sh\nprintf "%s" "$PWD"\n', { mode: 0o700 });
      const launch = terminalLaunch({ terminal: "gnome-terminal", cwd }, "linux");
      const result = NodeChildProcess.execFileSync(launch.args[1]!, launch.args.slice(2), {
        env: { ...process.env, SHELL: shell },
        encoding: "utf8",
      });
      expect(result).toBe(cwd);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves a remote directory across the SSH shell boundary", () => {
    const cwd = "/srv/user's repo $(id); `whoami`";
    const launch = terminalLaunch(
      { terminal: "gnome-terminal", cwd, sshHost: "my-ssh-alias" },
      "linux",
    );
    expect(launch.args.slice(0, 5)).toEqual(["--", "ssh", "-t", "--", "my-ssh-alias"]);
    // Substitute shell builtins to observe cd's argument without requiring that remote path locally.
    const inner = NodeChildProcess.execFileSync(
      "/bin/sh",
      ["-c", `capture() { printf '%s' "$2"; }; ${launch.args[5]!.replace("/bin/sh", "capture")}`],
      { encoding: "utf8" },
    );
    const command = `cd() { printf '%s' "$1"; }; exec() { :; }; ${inner}`;
    expect(NodeChildProcess.execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })).toBe(
      cwd,
    );
  });

  it.each(["terminal", "iterm2"] as const)("quotes commands through %s AppleScript", (terminal) => {
    const launch = terminalLaunch(
      { terminal, cwd: '/srv/a "quote" and \\ slash', sshHost: "dev" },
      "darwin",
    );
    const literal = launch.args[1]!.split("\n")[2]!.replace(
      /^(do script |create window with default profile command )/,
      "",
    );
    const command = JSON.parse(literal) as string;
    // Resolve the /bin/sh invocation once, then examine the command delivered to that shell.
    const args = NodeChildProcess.execFileSync(
      "/bin/sh",
      ["-c", `capture() { printf '%s' "$2"; }; ${command.replace("/bin/sh", "capture")}`],
      { encoding: "utf8" },
    );
    expect(args).toContain("'ssh' '-t' '--' 'dev'");
    expect(launch.file).toBe("/usr/bin/osascript");
  });

  it("passes Windows paths as encoded PowerShell data, including WT's semicolon separator", () => {
    const launch = terminalLaunch(
      { terminal: "system", cwd: "C:\\users\\O'Brien; $(whoami)" },
      "win32",
    );
    expect(launch.file).toBe("wt.exe");
    expect(Buffer.from(launch.args.at(-1)!, "base64").toString("utf16le")).toBe(
      "Set-Location -LiteralPath 'C:\\users\\O''Brien; $(whoami)'",
    );
  });

  it("opens WSL in the selected running distribution", () => {
    const launch = terminalLaunch(
      { terminal: "system", cwd: "/home/me/repo", wslDistro: "Ubuntu" },
      "win32",
    );
    expect(Buffer.from(launch.args.at(-1)!, "base64").toString("utf16le")).toBe(
      `Start-Process -FilePath 'wsl.exe' -ArgumentList '"--distribution" "Ubuntu" "--cd" "/home/me/repo"' -NoNewWindow -Wait`,
    );
  });

  it.each(["-oProxyCommand=evil", "host;id", "host\ncommand"])(
    "rejects an unsafe SSH host %s",
    (sshHost) => {
      expect(() =>
        terminalLaunch({ terminal: "system", cwd: "/repo", sshHost }, "darwin"),
      ).toThrow();
    },
  );

  it("rejects an unsupported terminal rather than silently changing the preference", () => {
    expect(() => terminalLaunch({ terminal: "iterm2", cwd: "/repo" }, "linux")).toThrow();
  });
});

describe("external terminal process lifecycle", () => {
  function processSpawner(exitCode: number | null, onUnref: () => void) {
    return ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode:
            exitCode === null
              ? Effect.never
              : Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(exitCode === null),
          kill: () => Effect.void,
          unref: Effect.sync(() => {
            onUnref();
            return Effect.void;
          }),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
  }

  effectIt.effect("reports launcher failures instead of claiming the terminal opened", () =>
    Effect.gen(function* () {
      const error = yield* launchExternalTerminal(
        { terminal: "terminal", cwd: "/repo" },
        "darwin",
      ).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          processSpawner(1, () => {}),
        ),
        Effect.flip,
      );
      expect(error.message).toContain("Could not open the terminal");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  effectIt.effect(
    "releases a long-running native terminal without waiting for its window to close",
    () =>
      Effect.gen(function* () {
        let unreferenced = false;
        yield* launchExternalTerminal({ terminal: "konsole", cwd: "/repo" }, "linux").pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            processSpawner(null, () => {
              unreferenced = true;
            }),
          ),
        );
        expect(unreferenced).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
