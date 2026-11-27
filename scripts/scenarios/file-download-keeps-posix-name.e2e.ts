import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A POSIX file download keeps the text before a literal backslash",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const name = "report\\draft.txt";
    const project = await t3.project("demo", { [name]: "Contents of the draft." });
    const thread = await t3.thread({ project, title: "Download a draft", messages: ["Start"] });
    await t3.open(thread);
    await screen.getByText("fixture turn complete", { exact: false }).waitFor({ state: "visible" });

    await browser.keyboard.press("Control+p");
    await screen.getByPlaceholder("Search files…").fill("README.md");
    await screen.getByRole("option", "README.md", { exact: false }).tap();

    await browser.locator('[data-item-path="report\\\\draft.txt"]').secondaryTap();
    const download = screen.getByRole("menuitem", "Download", { exact: true });
    await download.waitFor({ state: "visible" });
    await app.screenshot("file-download");
    const { suggestedFilename } = await browser.waitForDownload(() => download.tap());
    expect(suggestedFilename).toMatch(/^report.draft\.txt$/);
  },
);
