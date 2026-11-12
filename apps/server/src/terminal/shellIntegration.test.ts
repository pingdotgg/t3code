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

const installed = (shell: string) =>
  HostProcess.Platform.defaultValue() !== "win32" &&
  NodeChildProcess.spawnSync(shell, ["-c", "true"]).status === 0;

const bashMajor = installed("bash")
  ? Number(
      NodeChildProcess.spawnSync("bash", ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" })
        .stdout,
    )
  : 0;

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
            shellName: "zsh",
            args: ["-o", "nopromptsp"],
            env: { PATH, HOME: home, ZDOTDIR: zdotdir },
            paths,
          }),
          commands: 'print -r -- "$FROM_ZSHENV $FROM_ZSHRC $ZDOTDIR"\n',
        });
        expect(result.stdout).toBe(`1 1 ${zdotdir}\n`);
        expect(result.stderr).toContain(`${PROMPT_START}themed % ${INPUT_START}`);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  const bashFixture = fixture({
    ".bash_profile": "FROM=profile\nPS1='top\\nlast\\$ '\n",
    ".bashrc": "FROM=bashrc\nPS1='rc\\$ '\n",
  });
  const runBash = (input: {
    readonly paths: Parameters<typeof withShellIntegration>[0]["paths"];
    readonly home: string;
    readonly login: boolean;
  }) =>
    runInteractive({
      shell: "bash",
      launch: withShellIntegration({
        shellName: "bash",
        args: input.login ? ["-l"] : [],
        env: { PATH, HOME: input.home },
        paths: input.paths,
      }),
      commands: 'echo "$FROM"\n',
    });

  it.live.skipIf(!installed("bash"))("bash reads the files it would have read", () =>
    Effect.gen(function* () {
      const { home, paths } = yield* bashFixture;
      expect(runBash({ paths, home, login: true }).stdout).toBe("profile\n");
      expect(runBash({ paths, home, login: false }).stdout).toBe("bashrc\n");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(bashMajor < 4)("bash 4 and later mark only the last line of the prompt", () =>
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

  it.live.skipIf(bashMajor !== 3)("bash 3 leaves its prompt unmarked", () =>
    Effect.gen(function* () {
      const { home, paths } = yield* bashFixture;
      const stderr = runBash({ paths, home, login: false }).stderr;
      expect(stderr).toContain("rc$ ");
      expect(stderr).not.toContain("\u001b]133;");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
