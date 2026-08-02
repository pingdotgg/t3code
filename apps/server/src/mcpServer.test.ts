import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { __testing, startMcpHttpServer } from "./mcpServer.ts";

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

describe("MCP Streamable HTTP server", () => {
  it("serves authenticated workspace tools over loopback HTTP", async () => {
    const server = await startMcpHttpServer({
      cwd: process.cwd(),
      toolsets: new Set(["create_isolated_workspace", "switch_workspace", "create_nested_thread"]),
      threadId: "thread-1",
      cliCommand: "t3-test",
    });

    try {
      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          authorization: server.authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            { name: "create_isolated_workspace" },
            { name: "switch_workspace" },
            { name: "create_nested_thread" },
          ],
        },
      });

      const unauthenticated = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });
      expect(unauthenticated.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("closes active HTTP connections during shutdown", async () => {
    const server = await startMcpHttpServer({
      cwd: process.cwd(),
      toolsets: new Set(),
      threadId: "thread-1",
      cliCommand: "t3-test",
    });
    const { hostname, port } = new URL(server.url);
    const socket = createConnection(Number(port), hostname);

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      const socketClosed = new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      });
      await Promise.all([server.close(), socketClosed]);
    } finally {
      socket.destroy();
    }
  });
});

describe("create_nested_thread MCP tool", () => {
  it("creates a flavor-scoped child of the authenticated current thread", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-nested-thread-"));
    const cliPath = path.join(root, "t3-test");
    const argsPath = path.join(root, "cli-args.txt");
    const originalArgsPath = process.env.T3_MCP_TEST_ARGS;

    try {
      await writeFile(
        cliPath,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$T3_MCP_TEST_ARGS"\nprintf \'{"threadId":"child-1"}\\n\'\n',
      );
      await chmod(cliPath, 0o755);
      process.env.T3_MCP_TEST_ARGS = argsPath;

      await expect(
        __testing.createNestedThreadTool(
          {
            cwd: root,
            toolsets: new Set(["create_nested_thread"]),
            threadId: "parent-1",
            cliCommand: cliPath,
            cliArgsPrefix: ["server.mjs"],
            cliBaseDir: "/tmp/t3-dev",
            runtimeMode: "approval-required",
          },
          {
            project: "project-1",
            title: "Investigate nesting",
            prompt: "Find the root cause.",
            model: "gpt-5.6-terra",
            reasoning: "high",
          },
        ),
      ).resolves.toBe('{"threadId":"child-1"}');

      expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
        "server.mjs",
        "chat",
        "new",
        "--project",
        "project-1",
        "--parent",
        "parent-1",
        "--provider",
        "copilot",
        "--model",
        "gpt-5.6-terra",
        "--reasoning",
        "high",
        "--runtime-mode",
        "approval-required",
        "--title",
        "Investigate nesting",
        "Find the root cause.",
        "--base-dir",
        "/tmp/t3-dev",
      ]);
    } finally {
      if (originalArgsPath === undefined) delete process.env.T3_MCP_TEST_ARGS;
      else process.env.T3_MCP_TEST_ARGS = originalArgsPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});

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

  it("creates a worktree and records the thread binding through an absolute CLI path", async () => {
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
            cliCommand: cliPath,
            cliArgsPrefix: ["server.mjs"],
            cliBaseDir: "/tmp/t3-dev",
          },
          { branch: "feature/worktree", path: targetPath },
        ),
      );

      expect(result).toMatchObject({
        branch: "feature/worktree",
        baseRef: "main",
        worktreePath: targetPath,
        continuationQueued: true,
        // The note is the model's only instruction about the turn boundary, so
        // it must both stop the turn and keep the mechanics out of the reply.
        note: expect.stringMatching(
          /Stop this turn now.*without explaining the handoff or the turn boundary.*resumes the task automatically/,
        ),
      });
      const cliArgs = (await readFile(argsPath, "utf8")).trim().split("\n");
      expect(cliArgs).toEqual([
        "server.mjs",
        "chat",
        "handoff",
        "thread-1",
        "--branch",
        "feature/worktree",
        "--worktree",
        targetPath,
        "--continue-prompt",
        expect.stringContaining("Continue the task"),
        "--command-id",
        expect.stringMatching(/^workspace-handoff:/),
        "--base-dir",
        "/tmp/t3-dev",
      ]);
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
      await writeFile(
        cliPath,
        '#!/bin/sh\nprintf "ORCHESTRATION_COMMAND_REJECTED: binding failed\\n"\nprintf "SQLite warning\\n" >&2\nexit 1\n',
      );
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
      ).rejects.toThrow(/binding failed[\s\S]*SQLite warning/);

      await expect(readFile(targetPath, "utf8")).rejects.toThrow();
      await expect(
        run("git", ["rev-parse", "--verify", "--quiet", "feature/worktree"], root),
      ).rejects.toThrow();
    } finally {
      process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("preserves the worktree when binding may have committed before the response was lost", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-worktree-"));
    const targetPath = `${root}-uncertain-worktree`;
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
      await writeFile(cliPath, '#!/bin/sh\nprintf "response lost\\n" >&2\nexit 1\n');
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
          { branch: "feature/uncertain", path: targetPath },
        ),
      ).rejects.toThrow("worktree was preserved");

      await expect(readFile(path.join(targetPath, "README.md"), "utf8")).resolves.toBe("base\n");
      await expect(
        run("git", ["rev-parse", "--verify", "feature/uncertain"], root),
      ).resolves.toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });
});

describe("switch_workspace MCP tool", () => {
  it("binds an existing worktree from the same repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-workspace-switch-"));
    const targetPath = `${root}-existing-worktree`;
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
      await run("git", ["worktree", "add", "-b", "feature/existing", targetPath], root);
      await mkdir(binDir);
      await writeFile(cliPath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$T3_MCP_TEST_ARGS"\n');
      await chmod(cliPath, 0o755);
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
      process.env.T3_MCP_TEST_ARGS = argsPath;

      const result = JSON.parse(
        await __testing.switchWorkspaceTool(
          {
            cwd: root,
            toolsets: new Set(["switch_workspace"]),
            threadId: "thread-1",
            cliCommand: "t3-test",
          },
          { path: targetPath },
        ),
      );

      expect(result).toMatchObject({
        branch: "feature/existing",
        worktreePath: targetPath,
        continuationQueued: true,
      });
      expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
        "chat",
        "handoff",
        "thread-1",
        "--branch",
        "feature/existing",
        "--worktree",
        targetPath,
        "--continue-prompt",
        expect.stringContaining("Continue the task"),
        "--command-id",
        expect.stringMatching(/^workspace-handoff:/),
      ]);
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

  it("retries workspace binding with the same durable command id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-workspace-retry-"));
    const targetPath = `${root}-existing-worktree`;
    const binDir = path.join(root, "bin");
    const cliPath = path.join(binDir, "t3-test");
    const firstArgsPath = path.join(root, "first-args.txt");
    const retryArgsPath = path.join(root, "retry-args.txt");
    const countPath = path.join(root, "count");
    const originalPath = process.env.PATH;
    const originalFirstArgsPath = process.env.T3_MCP_TEST_FIRST_ARGS;
    const originalRetryArgsPath = process.env.T3_MCP_TEST_RETRY_ARGS;
    const originalCountPath = process.env.T3_MCP_TEST_COUNT;

    try {
      await writeFile(path.join(root, "README.md"), "base\n");
      await run("git", ["init", "--initial-branch=main"], root);
      await run("git", ["config", "user.email", "test@example.com"], root);
      await run("git", ["config", "user.name", "T3 Test"], root);
      await run("git", ["add", "README.md"], root);
      await run("git", ["commit", "-m", "initial"], root);
      await run("git", ["worktree", "add", "-b", "feature/retry", targetPath], root);
      await mkdir(binDir);
      await writeFile(
        cliPath,
        '#!/bin/sh\nif [ ! -f "$T3_MCP_TEST_COUNT" ]; then\n  touch "$T3_MCP_TEST_COUNT"\n  printf "%s\\n" "$@" > "$T3_MCP_TEST_FIRST_ARGS"\n  exit 1\nfi\nprintf "%s\\n" "$@" > "$T3_MCP_TEST_RETRY_ARGS"\n',
      );
      await chmod(cliPath, 0o755);
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
      process.env.T3_MCP_TEST_FIRST_ARGS = firstArgsPath;
      process.env.T3_MCP_TEST_RETRY_ARGS = retryArgsPath;
      process.env.T3_MCP_TEST_COUNT = countPath;

      await __testing.switchWorkspaceTool(
        {
          cwd: root,
          toolsets: new Set(["switch_workspace"]),
          threadId: "thread-1",
          cliCommand: "t3-test",
        },
        { path: targetPath },
      );

      const firstArgs = (await readFile(firstArgsPath, "utf8")).trim().split("\n");
      const retryArgs = (await readFile(retryArgsPath, "utf8")).trim().split("\n");
      expect(retryArgs).toEqual(firstArgs);
      expect(firstArgs[firstArgs.indexOf("--command-id") + 1]).toMatch(/^workspace-handoff:/);
    } finally {
      process.env.PATH = originalPath;
      if (originalFirstArgsPath === undefined) delete process.env.T3_MCP_TEST_FIRST_ARGS;
      else process.env.T3_MCP_TEST_FIRST_ARGS = originalFirstArgsPath;
      if (originalRetryArgsPath === undefined) delete process.env.T3_MCP_TEST_RETRY_ARGS;
      else process.env.T3_MCP_TEST_RETRY_ARGS = originalRetryArgsPath;
      if (originalCountPath === undefined) delete process.env.T3_MCP_TEST_COUNT;
      else process.env.T3_MCP_TEST_COUNT = originalCountPath;
      await rm(root, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it("rejects a worktree from another repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "t3-mcp-workspace-source-"));
    const other = await mkdtemp(path.join(tmpdir(), "t3-mcp-workspace-other-"));

    try {
      for (const cwd of [root, other]) {
        await writeFile(path.join(cwd, "README.md"), "base\n");
        await run("git", ["init", "--initial-branch=main"], cwd);
        await run("git", ["config", "user.email", "test@example.com"], cwd);
        await run("git", ["config", "user.name", "T3 Test"], cwd);
        await run("git", ["add", "README.md"], cwd);
        await run("git", ["commit", "-m", "initial"], cwd);
      }

      await expect(
        __testing.switchWorkspaceTool(
          {
            cwd: root,
            toolsets: new Set(["switch_workspace"]),
            threadId: "thread-1",
            cliCommand: "t3-test",
          },
          { path: other },
        ),
      ).rejects.toThrow("same Git repository");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });
});
