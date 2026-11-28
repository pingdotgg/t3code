import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Jira's missing site message names the field in the selected language",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    await t3.open("/settings/general");
    await screen.getByLabel("Language", { exact: true }).tap();
    await screen.getByText("Deutsch", { exact: true }).tap();
    await screen.getByLabel("Sprache", { exact: true }).waitFor();
    await t3.open("/settings/source-control");

    await screen.getByRole("button", /Jira.*Details|Details.*Jira/).tap();
    await browser
      .locator('input[type="password"][id^="issue-tracker-jira-"]')
      .fill("example-token");
    await browser.keyboard.press("Enter");

    const validation = screen.getByText(/Gib zuerst .+ ein\./);
    await validation.waitFor();
    await app.screenshot("jira-required-site-message");
    const message = await validation.textContent();
    await expect(message).toMatch(/\b(?:Website|Adresse|Domain|Instanz)\b/i);
    await expect(message).toBe("Gib zuerst die Website ein.");
  },
);
