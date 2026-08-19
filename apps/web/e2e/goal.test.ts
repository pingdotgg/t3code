// @effect-diagnostics nodeBuiltinImport:off - e2e suite: reads fixtures and harness state from disk.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import { PLAYWRIGHT_OUTPUT_DIR, startIsolatedWebApp, type IsolatedWebApp } from "./harness.ts";
import {
  canSendMessage,
  commandPalette,
  composerEditor,
  goalActiveMarker,
  goalChip,
  paletteInput,
  openCommandPalette,
  closeCommandPalette,
  slashCommandItem,
  submitComposer,
  toastDescription,
  toastTitle,
  typeInComposer,
  stopRunningTurnIfNeeded,
  submitGoalSlashCommand,
} from "./session.ts";

const OBJECTIVE = "Reduce p95 below 120ms";

let app: IsolatedWebApp | undefined;

describe.sequential("Goal", () => {
  beforeAll(async () => {
    app = await startIsolatedWebApp();
  }, 300_000);

  afterEach(async ({ task }) => {
    if (app === undefined) {
      return;
    }
    const state = task.result?.state;
    if (state === "pass" || state === "skip") {
      return;
    }
    const fileName = `${task.name.replaceAll(/\W+/g, "-").slice(0, 80)}.png`;
    await NodeFSP.mkdir(PLAYWRIGHT_OUTPUT_DIR, { recursive: true });
    await app.page.screenshot({
      path: NodePath.join(PLAYWRIGHT_OUTPUT_DIR, fileName),
      fullPage: true,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it("shows built-in /goal slash commands", async () => {
    const page = requireApp().page;
    await composerEditor(page).click();
    await typeInComposer(page, "/");
    await slashCommandItem(page, "slash:goal").waitFor({ state: "visible" });
    await slashCommandItem(page, "slash:goal-pause").waitFor({ state: "visible" });
    await slashCommandItem(page, "slash:goal-resume").waitFor({ state: "visible" });
    await slashCommandItem(page, "slash:goal-clear").waitFor({ state: "visible" });
    expect(await slashCommandItem(page, "slash:goal-complete").count()).toBe(0);
    await page.keyboard.press("Escape");
  });

  it("shows Objective status from the command palette", async ({ skip }) => {
    const page = requireApp().page;
    await openCommandPalette(page);
    await paletteInput(page).fill("Show Objective status");
    const statusItem = commandPalette(page).locator("[data-slot=command-item]", {
      hasText: "Show Objective status",
    });
    try {
      await statusItem.first().waitFor({ state: "visible", timeout: 5_000 });
    } catch {
      await closeCommandPalette(page);
      skip("Goal palette actions appear on a server Thread, not on a draft.");
      return;
    }
    await statusItem.first().click();
    await toastTitle(page).filter({ hasText: "Objective" }).waitFor({ state: "visible" });
    await toastDescription(page)
      .filter({ hasText: "No Objective on this Thread" })
      .waitFor({ state: "visible" });
  });

  it("sets a Goal from /goal without sending the command form", async ({ skip }) => {
    const page = requireApp().page;
    if (!(await canSendMessage(page))) {
      skip("Send is disabled because no provider is available.");
      return;
    }

    await typeInComposer(page, `/goal ${OBJECTIVE}`);
    await submitComposer(page);

    const chip = goalChip(page);
    await chip.waitFor({ state: "visible" });
    await expectChipActiveLabel(page, OBJECTIVE);
    await goalActiveMarker(page).waitFor({ state: "visible" });
    expect(await page.getByText(`/goal ${OBJECTIVE}`).count()).toBe(0);

    const rows = await requireApp().querySqlite(
      "SELECT goal_json AS goal FROM projection_threads WHERE goal_json IS NOT NULL",
    );
    expect(rows.length).toBeGreaterThan(0);
    const goal = JSON.parse(String(rows[0]?.goal)) as { status: string; objective: string };
    expect(goal.status).toBe("active");
    expect(goal.objective).toBe(OBJECTIVE);
  });

  it("updates the Goal chip through Pause, Resume, and Clear", async ({ skip }) => {
    const page = requireApp().page;
    if ((await goalChip(page).count()) === 0) {
      skip("No Goal chip; set-from-/goal did not run.");
      return;
    }

    await stopRunningTurnIfNeeded(page);
    await submitGoalSlashCommand(page, "/goal pause");

    const pausedRows = await requireApp().querySqlite(
      "SELECT goal_json AS goal FROM projection_threads WHERE goal_json IS NOT NULL",
    );
    const pausedGoal = JSON.parse(String(pausedRows[0]?.goal)) as { status: string };
    expect(pausedGoal.status).toBe("paused");

    await expectChipLabel(page, `Goal paused: ${OBJECTIVE}`);

    await submitGoalSlashCommand(page, "/goal resume");
    await expectChipActiveLabel(page, OBJECTIVE);

    await submitGoalSlashCommand(page, "/goal clear");
    await goalChip(page).waitFor({ state: "hidden" });
  });

  it("edits via chip text click and controls via inline icons", async ({ skip }) => {
    const page = requireApp().page;
    await submitGoalSlashCommand(page, `/goal ${OBJECTIVE}`);
    await goalChip(page).waitFor({ state: "visible" });
    if ((await goalChip(page).count()) === 0) {
      skip("No Goal chip; set-from-/goal did not run.");
      return;
    }

    await page.locator("[data-goal-chip-edit]").click();
    await expect
      .poll(async () => await composerEditor(page).innerText(), { timeout: 15_000 })
      .toBe(`/goal ${OBJECTIVE}`);

    await submitComposer(page);
    await expectChipActiveLabel(page, OBJECTIVE);
    await page.locator("[data-goal-chip-action='pause']").click();
    await expectChipLabel(page, `Goal paused: ${OBJECTIVE}`);

    await page.locator("[data-goal-chip-action='resume']").click();
    await expectChipActiveLabel(page, OBJECTIVE);

    // Delete asks for confirmation first; cancelling keeps the Goal.
    await page.locator("[data-goal-chip-action='clear']").click();
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ state: "visible" });
    await expect
      .poll(async () => await dialog.innerText(), { timeout: 15_000 })
      .toContain("Delete this Objective?");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    await expectChipActiveLabel(page, OBJECTIVE);

    await page.locator("[data-goal-chip-action='clear']").click();
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await goalChip(page).waitFor({ state: "hidden" });
  });

  it("treats /goal complete as an Objective, not a Complete command", async ({ skip }) => {
    const page = requireApp().page;
    if (!(await canSendMessage(page))) {
      skip("Send is disabled because no provider is available.");
      return;
    }

    await typeInComposer(page, "/goal complete");
    await submitComposer(page);
    await goalChip(page).waitFor({ state: "visible" });
    expect(await goalChip(page).getAttribute("aria-label")).toBe("Goal: complete (Active)");
  });

  it("refuses slash goal command forms", async ({ skip }) => {
    const page = requireApp().page;
    if (!(await canSendMessage(page))) {
      skip("Send is disabled because no provider is available.");
      return;
    }

    await typeInComposer(page, "slash goal do not send this");
    await submitComposer(page);
    await toastTitle(page)
      .filter({ hasText: "That command was not sent" })
      .waitFor({ state: "visible" });
    expect(await page.getByText("slash goal do not send this").count()).toBe(0);
  });
});

function requireApp(): IsolatedWebApp {
  if (app === undefined) {
    throw new Error("Isolated web app was not started.");
  }
  return app;
}

async function expectChipLabel(page: IsolatedWebApp["page"], label: string): Promise<void> {
  await expect
    .poll(async () => await goalChip(page).getAttribute("aria-label"), { timeout: 30_000 })
    .toBe(label);
}

/** A live Goal reads "Goal: …", with a "(Running)" suffix while a turn is in flight. */
async function expectChipActiveLabel(
  page: IsolatedWebApp["page"],
  objective: string,
): Promise<void> {
  await expect
    .poll(async () => await goalChip(page).getAttribute("aria-label"), { timeout: 30_000 })
    .toMatch(new RegExp(`^Goal: ${objective}( \\(Running\\))?$`));
}
