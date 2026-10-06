import { expect } from "e2e";

import { WAITING_TEXT } from "../fixtures/scenario.ts";
import { describe, test } from "../support/test.ts";

describe("agent turns", { tags: ["turns"] }, () => {
  test("a message gets a streamed reply and names the thread", async ({ t3, browser }) => {
    await t3.startThread("Say hello to the e2e suite");
    await expect(browser).not.toHaveURL(/\/draft\//);
  });

  test("a follow-up continues the same thread", async ({ t3, browser, screen }) => {
    await t3.startThread("First question");
    await t3.send("Second question");
    await expect(screen.getByText("Fake Codex received: Second question")).toBeVisible();
    await expect(screen.getByText("Fake Codex received: First question")).toBeVisible();
    // Reopened from the sidebar: the first load after starting a thread from the
    // palette's "New thread in..." currently lands on the bootstrap thread instead.
    await browser.reload();
    await t3.sidebarRow("First question").tap();
    await expect(screen.getByText("Fake Codex received: Second question")).toBeVisible();
    await expect(screen.getByText("Fake Codex received: First question")).toBeVisible();
  });

  test("Stop interrupts a running turn", async ({ t3, screen }) => {
    await t3.startDraft();
    await t3.send("wait until I stop you");
    await expect(screen.getByText(WAITING_TEXT)).toBeVisible();
    await screen.getByRole("button", "Stop generation").tap();
    await expect(screen.getByText("Run interrupted")).toBeVisible();
    await t3.waitForIdle();
  });
});
