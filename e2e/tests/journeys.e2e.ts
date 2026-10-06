// @effect-diagnostics nodeBuiltinImport:off - reads the test's repository, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, unique } from "e2e";

import { describe, test } from "../support/test.ts";

/**
 * Journeys a user would describe in words, driven by `agent.act` one goal at a time and
 * pinned with exact checks after each. Passing actions replay from `.e2e/cache` without
 * model calls; the outcome checks always run.
 */
describe(
  "agent journeys",
  {
    tags: ["agent"],
    skip: process.env.AI_GATEWAY_API_KEY ? false : "needs AI_GATEWAY_API_KEY for agent steps",
  },
  () => {
    test("a user starts a thread in a project and approves the agent's command", async ({
      agent,
      screen,
      t3,
    }) => {
      const project = await t3.addProject("journey-project");
      await t3.open();

      await agent.act("start a new thread in the {project} project", {
        params: { project: unique(project.title) },
      });
      await expect(
        screen.getByRole("heading", `What should we build in ${project.title}?`),
      ).toBeVisible();

      await agent.act("switch the runtime mode to Supervised");
      await expect(screen.getByRole("combobox", "Runtime mode")).toHaveText("Supervised");

      await agent.act("send the message {message}", { params: { message: "write plan.md" } });
      await expect(screen.getByRole("group", "Command approval")).toBeVisible();

      await agent.act("approve the pending command");
      await expect(screen.getByText("Wrote plan.md.")).toBeVisible();
      expect(NodeFS.existsSync(NodePath.join(project.root, "plan.md"))).toBe(true);
    });

    test("the terminal shows a command's output", async ({ agent, t3 }) => {
      const project = await t3.addProject("journey-terminal");
      await t3.startDraft(project);

      await agent.act("open the terminal drawer and run the command {command}", {
        params: { command: "echo agent-terminal-ok > proof.txt && cat proof.txt" },
      });
      await expect
        .poll(() => NodeFS.existsSync(NodePath.join(project.root, "proof.txt")))
        .toBe(true);
      await agent.assert('the terminal output shows the line "agent-terminal-ok"', {
        vision: true,
      });
    });

    test("a snoozed thread can be woken again", async ({ agent, screen, t3 }) => {
      await t3.startThread("Snooze me");

      await agent.act("snooze the open thread for one hour from its thread actions menu");
      const snoozedShelf = screen.getByTestId("sidebar-snoozed-header");
      await expect(snoozedShelf).toHaveText("Snoozed (1)");

      await agent.act('wake the snoozed thread "Snooze me" now');
      await expect(screen.getByText("Snoozed (1)")).not.toBeVisible();
      await expect(t3.sidebarRow("Snooze me")).toBeVisible();
    });

    test("a reasoning effort chosen in the composer sticks", async ({ agent, screen, t3 }) => {
      await t3.startDraft();

      await agent.act("set the reasoning effort to Low");
      await expect(screen.getByRole("button", "Low")).toBeVisible();

      await t3.send("Effort check");
      await expect(screen.getByText("Fake Codex received: Effort check")).toBeVisible();
      await expect(screen.getByRole("button", "Low")).toBeVisible();
    });
  },
);
