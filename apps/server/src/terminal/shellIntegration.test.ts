// @effect-diagnostics-next-line nodeBuiltinImport:off -- Shells need piped stdin and a tty-less stderr, which spawnSync gives directly.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { withShellIntegration, writeShellIntegration } from "./shellIntegration.ts";

const PROMPT_START = "\u001b]133;A;redraw=1\u0007";
const PROMPT_LINE_START = "\u001b]133;P;k=i\u0007";
const INPUT_START = "\u001b]133;I\u0007";
const PATH = process.env.PATH;
const PLATFORM = HostProcess.Platform.defaultValue();

const installed = (shell: string) =>
  PLATFORM !== "win32" && NodeChildProcess.spawnSync(shell, ["-c", "true"]).status === 0;

// The bash on PATH, by its full path, as T3 Code would start it from $SHELL.
const bash = installed("bash")
  ? NodeChildProcess.spawnSync("bash", ["-c", 'command -v "$0"', "bash"], {
      encoding: "utf8",
    }).stdout.trim()
  : "";
const bashMajor =
  bash === ""
    ? 0
    : Number(
        NodeChildProcess.spawnSync(bash, ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" })
          .stdout,
      );
// macOS /bin/bash starts without integration; see bashReadsEnvInPosixMode.
const bashIntegrated = bashMajor >= 4 && (PLATFORM !== "darwin" || bash !== "/bin/bash");

// An interactive shell reading piped commands still prints each prompt to stderr.
const runInteractive = (input: {
  readonly shell: string;
  readonly launch: { readonly args: ReadonlyArray<string>; readonly env: NodeJS.ProcessEnv };
  readonly commands: string;
}) =>
  NodeChildProcess.spawnSync(input.shell, [...input.launch.args, "-i"], {
    env: input.launch.env,
    input: input.commands,
    encoding: "utf8",
  });

const fixture = Effect.fn("shellIntegration.test.fixture")(function* (
  files: Record<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shell-integration-" });
  const home = path.join(root, "home");
  for (const [name, contents] of Object.entries(files)) {
    yield* fs.makeDirectory(path.dirname(path.join(home, name)), { recursive: true });
    yield* fs.writeFileString(path.join(home, name), contents);
  }
  const paths = yield* writeShellIntegration(path.join(root, "shell-integration"));
  return { home, paths, path };
});

describe("terminal shell integration", () => {
  it.live.skipIf(!installed("zsh"))(
    "zsh reads the user's startup files from their ZDOTDIR and marks the prompt a theme sets",
    () =>
      Effect.gen(function* () {
        const { home, paths, path } = yield* fixture({
          "zdot/.zshenv": "FROM_ZSHENV=1\n",
          "zdot/.zshrc": "FROM_ZSHRC=1\ntheme() { PS1='themed %# '; }\nprecmd_functions+=(theme)\n",
        });
        const zdotdir = path.join(home, "zdot");
        const result = runInteractive({
          shell: "zsh",
          launch: withShellIntegration({
            shell: "zsh",
            shellName: "zsh",
            platform: PLATFORM,
            args: ["-o", "nopromptsp"],
            env: { PATH, HOME: home, ZDOTDIR: zdotdir },
            paths,
          }),
          commands: 'print -r -- "FROM=$FROM_ZSHENV $FROM_ZSHRC $ZDOTDIR"\n',
        });
        // The host's own startup files can print too; look for this test's line.
        expect(result.stdout).toContain(`FROM=1 1 ${zdotdir}\n`);
        expect(result.stderr).toContain(`${PROMPT_START}themed % ${INPUT_START}`);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  // Host startup files load first and may set a prompt command of their own, so the
  // user's files clear it, as a user's own prompt setup would.
  const bashFixture = fixture({
    ".bash_profile": "unset PROMPT_COMMAND\nFROM=profile\nPS1='top\\nlast\\$ '\n",
    ".bashrc": "unset PROMPT_COMMAND\nFROM=bashrc\nPS1='rc\\$ '\n",
    ".bash_logout": "echo FROM=logout\n",
  });
  const runBash = (input: {
    readonly paths: Parameters<typeof withShellIntegration>[0]["paths"];
    readonly home: string;
    readonly login: boolean;
  }) =>
    runInteractive({
      shell: bash,
      launch: withShellIntegration({
        shell: bash,
        shellName: "bash",
        platform: PLATFORM,
        args: input.login ? ["-l"] : [],
        env: { PATH, HOME: input.home },
        paths: input.paths,
      }),
      commands:
        'echo "FROM=$FROM"\n' +
        "shopt -q login_shell && echo LOGIN=on || echo LOGIN=off\n" +
        "shopt -qo posix && echo POSIX=on || echo POSIX=off\n",
    });

  it.live.skipIf(!bashIntegrated)(
    "bash keeps its login mode and reads the files it would have read",
    () =>
      Effect.gen(function* () {
        const { home, paths } = yield* bashFixture;
        const login = runBash({ paths, home, login: true }).stdout;
        expect(login).toContain("FROM=profile\nLOGIN=on\nPOSIX=off\n");
        expect(login).toContain("FROM=logout\n");
        const nonLogin = runBash({ paths, home, login: false }).stdout;
        expect(nonLogin).toContain("FROM=bashrc\nLOGIN=off\nPOSIX=off\n");
        expect(nonLogin).not.toContain("FROM=logout");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(!bashIntegrated)("bash marks only the last line of the prompt", () =>
    Effect.gen(function* () {
      const { home, paths } = yield* bashFixture;
      expect(runBash({ paths, home, login: true }).stderr).toContain(
        `${PROMPT_START}top\r\n${PROMPT_LINE_START}last$ ${INPUT_START}`,
      );
      expect(runBash({ paths, home, login: false }).stderr).toContain(
        `${PROMPT_START}${PROMPT_LINE_START}rc$ ${INPUT_START}`,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("macOS starts /bin/bash and a bare bash as before", () => {
    const paths = { zdotdir: "/t3/zsh", bashRcfile: "/t3/bash/t3code.bash" };
    const env = { HOME: "/home/user" };
    for (const shell of ["/bin/bash", "bash"]) {
      expect(
        withShellIntegration({
          shell,
          shellName: "bash",
          platform: "darwin",
          args: ["-l"],
          env,
          paths,
        }),
      ).toEqual({ args: ["-l"], env });
    }
    expect(
      withShellIntegration({
        shell: "/opt/homebrew/bin/bash",
        shellName: "bash",
        platform: "darwin",
        args: ["-l"],
        env,
        paths,
      }),
    ).toEqual({
      args: ["--posix", "-l"],
      env: {
        HOME: "/home/user",
        ENV: "/t3/bash/t3code.bash",
        T3CODE_BASH_INJECT: "1",
        HISTFILE: "/home/user/.bash_history",
        T3CODE_BASH_UNEXPORT_HISTFILE: "1",
      },
    });
  });
});
