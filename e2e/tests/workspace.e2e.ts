// @effect-diagnostics nodeBuiltinImport:off - reads the test's repository, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { WRITTEN_CONTENT } from "../fixtures/scenario.ts";
import { describe, test } from "../support/test.ts";

const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });

describe("workspace changes", { tags: ["workspace"] }, () => {
  test("an approved command edits the workspace and shows its diff", async ({ t3, screen }) => {
    const project = await t3.addProject("approve-project");
    await t3.startDraft(project);
    await t3.chooseRuntimeMode(/^Supervised/);
    await t3.send("write notes.md");

    await expect(screen.getByRole("group", "Command approval")).toContainText(
      "May I write notes.md?",
    );
    await screen.getByRole("button", "Approve").tap();

    await expect(screen.getByText("Wrote notes.md.")).toBeVisible();
    expect(NodeFS.readFileSync(NodePath.join(project.root, "notes.md"), "utf8")).toBe(
      WRITTEN_CONTENT,
    );
    await expect(screen.getByText("1 changed file")).toBeVisible();
    await t3.waitForIdle();
    await screen.getByRole("button", "Open diff").tap();
    await expect(screen.getByRole("button", "Expand notes.md")).toBeVisible();
  });

  test("a declined command leaves the workspace untouched", async ({ t3, screen }) => {
    const project = await t3.addProject("decline-project");
    await t3.startDraft(project);
    await t3.chooseRuntimeMode(/^Supervised/);
    await t3.send("write notes.md");

    await expect(screen.getByRole("group", "Command approval")).toBeVisible();
    await screen.getByRole("button", "Decline").tap();

    await expect(screen.getByText("Okay, I did not write notes.md.")).toBeVisible();
    expect(NodeFS.existsSync(NodePath.join(project.root, "notes.md"))).toBe(false);
  });

  test("Commit records the agent's change on the branch", async ({ t3, screen }) => {
    const project = await t3.addProject("commit-project");
    await t3.startDraft(project);
    await t3.send("write notes.md");
    await expect(screen.getByText("Wrote notes.md.")).toBeVisible();
    await t3.waitForIdle();

    const gitActions = screen.getByRole("group", "Git actions");
    await gitActions.getByRole("button", "Commit").tap();
    await expect(gitActions.getByRole("status")).toContainText("Committed");

    expect(git(project.root, "show", "--name-only", "--format=", "HEAD").trim()).toBe("notes.md");
    expect(git(project.root, "status", "--porcelain")).toBe("");
  });

  test("the terminal drawer runs commands in the project", async ({ t3, screen }) => {
    const project = await t3.addProject("terminal-project");
    await t3.startDraft(project);
    await screen.getByRole("button", "Toggle terminal drawer").tap();
    const terminal = screen.getByLabel("Terminal input");
    const proof = NodePath.join(project.root, "terminal-proof.txt");
    // The drawer exposes no ready signal and keys typed before its shell starts are
    // dropped, so the idempotent command is retyped until it lands.
    await expect
      .poll(
        async () => {
          if (NodeFS.existsSync(proof)) return NodeFS.readFileSync(proof, "utf8");
          await terminal.pressSequentially("echo terminal-ok > terminal-proof.txt");
          await terminal.press("Enter");
          return "";
        },
        { interval: 2_000 },
      )
      .toBe("terminal-ok\n");
  });
});
