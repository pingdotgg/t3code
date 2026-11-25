import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "An open terminal updates its accessible input name when the app language changes",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Terminal work", messages: ["Start"] });

    await t3.open(thread);
    await screen.getByRole("button", "Toggle terminal drawer").tap();
    const input = browser.locator(".t3-ghostty-input[data-workspace-focus-default]");
    await input.waitFor();

    await screen.getByRole("button", "Settings", { exact: true }).tap();
    await screen.getByLabel("Language", { exact: true }).tap();
    await screen.getByText("日本語", { exact: true }).tap();
    await screen.getByLabel("言語", { exact: true }).waitFor();
    await browser.keyboard.press("Escape");

    await screen.getByRole("button", "ターミナルドロワーの切り替え").waitFor();
    await input.waitFor();
    await app.screenshot("terminal-input-after-language-change");
    await expect(input).toHaveAttribute("aria-label", "ターミナルの入力");
  },
);
