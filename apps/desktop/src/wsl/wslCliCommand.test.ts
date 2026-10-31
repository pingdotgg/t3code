// @effect-diagnostics nodeBuiltinImport:off - the executed suite runs the generated script through a real POSIX shell.
import * as NodeChildProcess from "node:child_process";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  buildWslCliCommandScript,
  buildWslCliTargetScript,
  parseWslCliCommandReport,
  type WslCliCommandAction,
} from "./wslCliCommand.ts";

// The script runs in the distro under `sh`. Any POSIX sh runs it here; a dev
// box without one on PATH skips rather than borrowing someone's WSL distro.
const hasSh =
  NodeChildProcess.spawnSync("sh", ["-c", "command -v grep && command -v sed && command -v mktemp"])
    .status === 0;

const runShell = (script: string) => {
  const result = NodeChildProcess.spawnSync("sh", ["-s"], { input: script, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const sh = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const RUNTIME = (name: string) =>
  `#!/bin/sh\nprintf '${name} %s %s %s\\n' "$T3CODE_HOME" "$T3CODE_CLI_PATH" "$*"\n`;

describe.skipIf(!hasSh)("t3 command in a WSL distro (executed)", () => {
  const fixtures: Array<string> = [];

  afterAll(() => {
    for (const work of fixtures) runShell(`rm -rf ${sh(work)}`);
  });

  // A distro home where the app has selected runtime `a`, and a login shell
  // whose PATH starts with ~/.local/bin, as Ubuntu's ~/.profile sets it.
  const createDistro = () => {
    const created = runShell(
      [
        "set -eu",
        "work=$(mktemp -d)",
        'mkdir -p "$work/home/.t3/wsl-runtime/a"',
        `printf '%s' ${sh(RUNTIME("a"))} > "$work/home/.t3/wsl-runtime/a/t3"`,
        'chmod +x "$work/home/.t3/wsl-runtime/a/t3"',
        `printf '%s\\n' '#!/bin/sh' 'printf "\\n__t3_path__:%s\\n" "$HOME/.local/bin"' > "$work/shell"`,
        'chmod +x "$work/shell"',
        'printf "%s" "$work"',
      ].join("\n"),
    );
    expect(created.status, created.stderr).toBe(0);
    const work = created.stdout;
    fixtures.push(work);
    const home = `${work}/home`;
    const env = `unset T3CODE_HOME\nexport HOME=${sh(home)} SHELL=${sh(`${work}/shell`)} WSL_DISTRO_NAME=Test`;
    const recorded = runShell(
      `${env}\n${buildWslCliTargetScript([`${home}/.t3/wsl-runtime/a/t3`])}`,
    );
    expect(recorded.status, recorded.stderr).toBe(0);
    return {
      work,
      home,
      run: (action: WslCliCommandAction) => {
        const result = runShell(`${env}\n${buildWslCliCommandScript(action)}`);
        expect(result.status, result.stderr).toBe(0);
        return parseWslCliCommandReport(result.stdout);
      },
      exec: (script: string) => runShell(`${env}\n${script}`),
    };
  };

  it("installs a t3 that keeps following the runtime the app selects", () => {
    const distro = createDistro();
    const launcher = `${distro.home}/.local/bin/t3`;

    expect(distro.run("install")).toEqual({
      distroName: "Test",
      installedPath: launcher,
      onPath: true,
      shadowedBy: null,
      failure: null,
    });
    expect(distro.exec(`${sh(launcher)} pair`).stdout).toBe(
      `a ${distro.home}/.t3 ${launcher} pair\n`,
    );

    // An app update installs runtime b, selects it and prunes a.
    const updated = distro.exec(
      [
        "set -eu",
        "runtimes=$HOME/.t3/wsl-runtime",
        'mkdir -p "$runtimes/b"',
        `printf '%s' ${sh(RUNTIME("b"))} > "$runtimes/b/t3"`,
        'chmod +x "$runtimes/b/t3"',
        buildWslCliTargetScript([`${distro.home}/.t3/wsl-runtime/b/t3`]),
        'rm -rf "$runtimes/a"',
        `${sh(launcher)} --version`,
      ].join("\n"),
    );
    expect(updated.stdout).toBe(`b ${distro.home}/.t3 ${launcher} --version\n`);

    const pruned = distro.exec(`rm -rf "$HOME/.t3/wsl-runtime/b"\n${sh(launcher)}`);
    expect(pruned.status).toBe(127);
    expect(pruned.stderr).toContain("Open T3 Code once to restore it.");
  });

  it("runs the server script when the app fell back to Node", () => {
    const distro = createDistro();
    const launcher = `${distro.home}/.local/bin/t3`;
    const node = `${distro.work}/node`;
    const server = `${distro.work}/server/bin.mjs`;
    const fellBack = distro.exec(
      [
        "set -eu",
        `mkdir -p ${sh(`${distro.work}/server`)}`,
        `printf '%s\\n' '#!/bin/sh' 'echo "node $*"' > ${sh(node)}`,
        `chmod +x ${sh(node)}`,
        `: > ${sh(server)}`,
        'rm -rf "$HOME/.t3/wsl-runtime/a"',
        buildWslCliTargetScript([node, server]),
      ].join("\n"),
    );
    expect(fellBack.status, fellBack.stderr).toBe(0);

    expect(distro.run("install").failure).toBeNull();
    expect(distro.exec(`${sh(launcher)} --version`).stdout).toBe(`node ${server} --version\n`);
  });

  it("falls back to the default PATH when the login shell never finishes", () => {
    const distro = createDistro();
    expect(distro.run("install").onPath).toBe(true);
    expect(
      distro.exec(
        `mkfifo "$HOME/blocked"
printf '%s\\n' '#!/bin/sh' 'echo $$ > "$HOME/probe-pid"' 'exec cat "$HOME/blocked"' > ${sh(`${distro.work}/shell`)}`,
      ).status,
    ).toBe(0);

    const result = NodeChildProcess.spawnSync("sh", ["-s"], {
      input: `export HOME=${sh(distro.home)} SHELL=${sh(`${distro.work}/shell`)}\n${buildWslCliCommandScript("state")}`,
      encoding: "utf8",
      // Under the project's 15 second test timeout, which a sync spawn would block.
      timeout: 14_000,
    });
    expect(result.signal).toBeNull();
    const pid = Number(distro.exec('cat "$HOME/probe-pid"').stdout.trim());
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(result.status, result.stderr).toBe(0);
    expect(parseWslCliCommandReport(result.stdout)).toMatchObject({
      installedPath: `${distro.home}/.local/bin/t3`,
      onPath: false,
    });
  });

  it("removes only the t3 it installed", () => {
    const distro = createDistro();
    const theirs = `${distro.home}/bin/t3`;
    expect(distro.exec(`mkdir -p "$HOME/bin"\nprintf '#!/bin/sh\\n' > ${sh(theirs)}`).status).toBe(
      0,
    );
    expect(distro.run("install").installedPath).toBe(`${distro.home}/.local/bin/t3`);

    expect(distro.run("uninstall")).toMatchObject({ installedPath: null, failure: null });
    const left = distro.exec(`ls "$HOME/.local/bin"; cat ${sh(theirs)}`);
    expect(left.stdout).toBe("#!/bin/sh\n");
  });

  it("refuses to install behind another t3 that runs first", () => {
    const distro = createDistro();
    expect(
      distro.exec(
        'mkdir -p "$HOME/.local/bin"\nprintf "#!/bin/sh\\n" > "$HOME/.local/bin/t3"\nchmod +x "$HOME/.local/bin/t3"',
      ).status,
    ).toBe(0);

    expect(distro.run("install")).toMatchObject({
      installedPath: null,
      shadowedBy: `${distro.home}/.local/bin/t3`,
      failure: "shadowed",
    });
  });
});
