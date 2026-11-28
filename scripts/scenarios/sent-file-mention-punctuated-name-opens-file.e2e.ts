/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const FILE = "C#/Program.cs";

test(
  "An @-mention of a file whose folder has # opens it after the message is sent",
  WEB,
  async ({ t3, app, screen, browser }) => {
    // The editor renders in a shadow root that locators do not reach.
    const editorText = () =>
      browser.evaluate(() => {
        for (const host of document.querySelectorAll("*")) {
          const content = host.shadowRoot?.querySelector("[data-content]");
          if (content) return content.textContent ?? "";
        }
        return null;
      });

    const project = await t3.project("demo", { [FILE]: "static void Main() {}\nProgram body\n" });
    const thread = await t3.thread({ project, title: "Mention", messages: ["Show me around"] });
    await t3.open(thread);

    const composer = screen.getByRole("textbox");
    await composer.pressSequentially("Review @Program");
    await screen.getByRole("option", "Program.cs", { exact: false }).tap();
    await browser.keyboard.press("Enter");

    const link = screen.getByRole("link", "Program.cs");
    await link.waitFor();
    await app.screenshot("sent-message");
    await link.tap();
    await expect.poll(editorText).toContain("Program body");
    await app.screenshot("file-opened");
  },
);
