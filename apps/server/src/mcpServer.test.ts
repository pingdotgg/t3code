import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { __testing } from "./mcpServer.ts";

const run = async (command: string, args: ReadonlyArray<string>, cwd: string) => {
  const result = await new Promise<{ readonly code: number | null; readonly stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stderr }));
    },
  );
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
};

describe("create_isolated_workspace MCP tool", () => {
  it("lists a valid object schema when the tool is enabled", () => {
    expect(__testing.availableTools(new Set(["create_isolated_workspace"]))).toEqual([
      expect.objectContaining({
        name: "create_isolated_workspace",
        inputSchema: expect.objectContaining({
          type: "object",
          required: ["branch", "path"],
        }),
      }),
    ]);
  });

  it("creates a worktree and records the thread binding through the T3 CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-worktree-"));
    const targetPath = `${root}-feature-worktree`;
    const binDir = path.join(root, "bin");
    const cliPath = path.join(binDir, "t3-test");
    const argsPath = path.join(root, "cli-args.txt");
    const originalPath = process.env.PATH;
    const originalArgsPath = process.env.T3_MCP_TEST_ARGS;

    try {
      await writeFile(path.join(root, "README.md"), "base\n");
      await run("git", ["init", "--initial-branch=main"], root);
      await run("git", ["config", "user.email", "test@example.com"], root);
      await run("git", ["config", "user.name", "T3 Test"], root);
      await run("git", ["add", "README.md"], root);
      await run("git", ["commit", "-m", "initial"], root);
      await mkdir(binDir);
      await writeFile(cliPath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$T3_MCP_TEST_ARGS"\n');
      await chmod(cliPath, 0o755);
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
      process.env.T3_MCP_TEST_ARGS = argsPath;

      const result = JSON.parse(
        await __testing.createIsolatedWorkspaceTool(
          {
            cwd: root,
            toolsets: new Set(["create_isolated_workspace"]),
            threadId: "thread-1",
            cliCommand: "t3-test",
          },
          { branch: "feature/worktree", path: targetPath },
        ),
      );

      expect(result).toMatchObject({
        branch: "feature/worktree",
        baseRef: "main",
        worktreePath: targetPath,
      });
      expect(await readFile(argsPath, "utf8")).toBe(
        `chat\nset-branch\nthread-1\n--branch\nfeature/worktree\n--worktree\n${targetPath}\n`,
      );
      await expect(readFile(path.join(targetPath, "README.md"), "utf8")).resolves.toBe("base\n");
    } finally {
      process.env.PATH = originalPath;
      if (originalArgsPath === undefined) {
        delete process.env.T3_MCP_TEST_ARGS;
      } else {
        process.env.T3_MCP_TEST_ARGS = originalArgsPath;
      }
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("removes the worktree when recording the binding fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-worktree-"));
    const targetPath = `${root}-feature-worktree`;
    const binDir = path.join(root, "bin");
    const cliPath = path.join(binDir, "t3-fails");
    const originalPath = process.env.PATH;

    try {
      await writeFile(path.join(root, "README.md"), "base\n");
      await run("git", ["init", "--initial-branch=main"], root);
      await run("git", ["config", "user.email", "test@example.com"], root);
      await run("git", ["config", "user.name", "T3 Test"], root);
      await run("git", ["add", "README.md"], root);
      await run("git", ["commit", "-m", "initial"], root);
      await mkdir(binDir);
      await writeFile(cliPath, "#!/bin/sh\nexit 1\n");
      await chmod(cliPath, 0o755);
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

      await expect(
        __testing.createIsolatedWorkspaceTool(
          {
            cwd: root,
            toolsets: new Set(["create_isolated_workspace"]),
            threadId: "thread-1",
            cliCommand: "t3-fails",
          },
          { branch: "feature/worktree", path: targetPath },
        ),
      ).rejects.toThrow("t3-fails");

      await expect(readFile(targetPath, "utf8")).rejects.toThrow();
    } finally {
      process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });
});
