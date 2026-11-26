import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

// A Simplified Chinese RTF saved with the GB18030 code page (\ansicpg54936).
const GB18030_RTF = String.raw`{\rtf1\ansi\ansicpg54936 Quarterly notes: \'d6\'d0\'ce\'c4 \'95\'32\'82\'36 \'82\'35\'8f\'33 \uc2\u20320\'c4\'e3 done\par}`;

test(
  "An RTF preview decodes text saved with the GB18030 code page",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo", { "notes.rtf": GB18030_RTF });
    const thread = await t3.thread({ project, title: "Review notes", messages: ["Start"] });
    await t3.open(thread);
    await screen.getByText("fixture turn complete", { exact: false }).waitFor();

    await browser.keyboard.press("Control+p");
    await screen.getByPlaceholder("Search files…").fill("notes.rtf");
    await screen.getByRole("option", "notes.rtf", { exact: false }).tap();

    const document = browser.frameLocator('iframe[title^="notes.rtf"]');
    try {
      // The first document preview loads its worker, which a cold Vite cache optimizes on demand.
      // List form treats a missing iframe as 0 matches (ASSERTION_FAILED) rather than LOCATOR_NOT_FOUND.
      await expect(document.locator("body")).toHaveText(["Quarterly notes: 中文 𠀀 龦 你 done"], {
        timeout: 120_000,
      });
    } finally {
      await app.screenshot("text");
    }
  },
);
