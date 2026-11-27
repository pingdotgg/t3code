import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A thread started with only a terminal excerpt gets a title in the app's language",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    await t3.open("/settings/general");
    await screen.getByLabel("Language", { exact: true }).tap();
    await screen.getByText("日本語", { exact: true }).tap();
    await screen.getByLabel("言語", { exact: true }).waitFor();

    await t3.open();
    const toggle = screen.getByRole("button", "ターミナルドロワーの切り替え");
    await toggle.tap();
    const input = browser.locator('[aria-label="ターミナルの入力"][data-workspace-focus-default]');
    await input.waitFor();
    await input.focus();
    await browser.keyboard.type("printf 'first\\nsecond\\n'\n");
    await browser.keyboard.press("Control+Shift+A");
    await browser.locator("canvas.cursor-text").secondaryTap();
    await screen.getByText("チャットに追加", { exact: true }).tap();

    const excerpt = browser.locator('[data-testid="composer-editor"]').getByText(/行目/);
    await excerpt.waitFor();
    const expectedTitle = (await excerpt.textContent())!.trim();
    await app.screenshot("terminal-excerpt-draft-row");
    await expect(browser.locator('[data-testid="sidebar-draft-row"]')).toContainText(expectedTitle);
    await toggle.tap();
    await screen.getByRole("button", "メッセージを送信", { exact: true }).tap();
    await browser.locator("[data-thread-title-chevron]").waitFor({ state: "attached" });
    const title = screen.getByRole("navigation", "スレッドのパンくずリスト").getByRole("heading");

    await app.screenshot("terminal-excerpt-and-thread-title");
    await expect(title).toHaveText(expectedTitle);
  },
);
