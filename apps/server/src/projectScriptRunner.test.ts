import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runProjectLifecycleScript } from "./projectScriptRunner";

function quotedNodeCommand(source: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

describe("runProjectLifecycleScript", () => {
  it("runs lifecycle scripts from the requested cwd with the provided env", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-project-script-runner-"));
    const resolvedTempDir = fs.realpathSync.native(tempDir);
    const command = quotedNodeCommand(
      "require('node:fs').writeFileSync('hook.txt', [process.cwd(), process.env.T3CODE_PROJECT_ROOT || '', process.env.T3CODE_WORKTREE_PATH || ''].join(String.fromCharCode(10)), 'utf8')",
    );

    await runProjectLifecycleScript({
      cwd: tempDir,
      command,
      env: {
        T3CODE_PROJECT_ROOT: "/repo/project",
        T3CODE_WORKTREE_PATH: "/repo/worktrees/thread-1",
      },
    });

    expect(fs.readFileSync(path.join(tempDir, "hook.txt"), "utf8")).toBe(
      `${resolvedTempDir}\n/repo/project\n/repo/worktrees/thread-1`,
    );
  });

  it("surfaces non-zero exits as normalized lifecycle errors", async () => {
    await expect(
      runProjectLifecycleScript({
        cwd: process.cwd(),
        command: quotedNodeCommand("process.exit(3)"),
      }),
    ).rejects.toThrow("Project lifecycle script failed: exited with code 3.");
  });

  it("surfaces timeouts as normalized lifecycle errors", async () => {
    const runProcessMock = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      code: null,
      signal: null,
      timedOut: true,
    }));

    await expect(
      runProjectLifecycleScript(
        {
          cwd: process.cwd(),
          command: "echo lifecycle",
        },
        { runProcess: runProcessMock },
      ),
    ).rejects.toThrow("Project lifecycle script failed: timed out after 300 seconds.");
  });
});
