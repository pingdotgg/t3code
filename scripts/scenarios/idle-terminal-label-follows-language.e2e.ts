import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "An idle numbered terminal shows its name in the app's language after switching threads",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Terminal work", messages: ["Start"] });
    await t3.thread({ project, title: "Other work", messages: ["Start"] });

    await t3.open("/settings/general");
    await screen.getByLabel("Language", { exact: true }).tap();
    await screen.getByText("日本語", { exact: true }).tap();
    await screen.getByLabel("言語", { exact: true }).waitFor();

    await t3.open(thread);
    const drawerToggle = screen.getByRole("button", "ターミナルドロワーの切り替え");
    await drawerToggle.tap();
    const input = browser.locator('[aria-label="ターミナルの入力"][data-workspace-focus-default]');
    await input.waitFor();
    await screen.getByRole("button", /^新しいターミナル(?: \(|$)/).tap();
    const secondTerminal = screen.getByRole("button", /^(?:Terminal 2|ターミナル 2)$/);
    await secondTerminal.waitFor();
    await screen.getByRole("button", "Other work", { exact: false }).tap();
    await screen.getByRole("button", "Terminal work", { exact: false }).tap();

    // Wait for a real process label so the idle assertion reads server metadata, not the fallback
    // shown while the second terminal is opening.
    await secondTerminal.tap();
    await input.focus();
    await browser.keyboard.type("sleep 60\n");
    await screen.getByRole("button", "sleep", { exact: true }).waitFor({ timeout: 40_000 });
    await input.focus();
    await browser.keyboard.press("Control+C");
    await secondTerminal.waitFor({ timeout: 40_000 });

    await app.screenshot("idle-terminal-after-switch");
    await expect(secondTerminal).toHaveText("ターミナル 2");
  },
);
