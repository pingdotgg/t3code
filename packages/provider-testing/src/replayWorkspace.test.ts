// @effect-diagnostics nodeBuiltinImport:off - exercises inherited environment in an isolated subprocess with throwaway repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

it("keeps inherited repository config and refs unchanged when creating a replay workspace", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-git-env-"));
  const target = NodePath.join(root, "target");
  const gitDir = NodePath.join(target, ".git");
  const env = {
    PATH: process.env.PATH ?? process.env.Path,
    SystemRoot: process.env.SystemRoot,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    GIT_CONFIG_GLOBAL: NodePath.join(root, "global-git-config"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: target, encoding: "utf8", env });
  try {
    NodeFS.mkdirSync(target);
    git("init", "--quiet");
    git(
      "-c",
      "user.name=Sentinel",
      "-c",
      "user.email=sentinel@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "sentinel",
    );
    const configPath = NodePath.join(gitDir, "config");
    const config = NodeFS.readFileSync(configPath, "utf8");
    const refs = git("show-ref");
    const setup = new URL("../../shared/src/testing/providerEnv.ts", import.meta.url).href;
    const fixture = new URL("./replayWorkspace.ts", import.meta.url).href;
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import ${JSON.stringify(setup)};
        import { makeCheckpointWorkspace } from ${JSON.stringify(fixture)};
        await makeCheckpointWorkspace("inherited-git-env");
      `,
      ],
      {
        encoding: "utf8",
        env: {
          ...env,
          GIT_DIR: gitDir,
          GIT_COMMON_DIR: gitDir,
          GIT_OBJECT_DIRECTORY: NodePath.join(gitDir, "objects"),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: NodePath.join(gitDir, "objects"),
          GIT_WORK_TREE: target,
          GIT_INDEX_FILE: NodePath.join(root, "inherited-index"),
        },
      },
    );
    expect(NodeFS.readFileSync(configPath, "utf8")).toBe(config);
    expect(git("show-ref")).toBe(refs);
    expect(result.status, result.stderr).toBe(0);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
