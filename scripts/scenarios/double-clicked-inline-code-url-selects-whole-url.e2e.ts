/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const URL = "https://emby.example.com";
const MESSAGE = `Add the server as \`${URL}\`, then run \`migration-gate --dry-run\`.`;

test(
  "Double-clicking a URL in inline code selects the whole URL",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Media server", messages: [MESSAGE] });
    await t3.open(thread);
    // A message sent through the CLI shows collapsed under its sender.
    await screen.getByRole("button", /^Agent Add/).tap();

    await screen.getByText(URL).dblclick();
    await app.screenshot("double-clicked");
    const selected = await browser.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected, "The double-click selects the whole URL").toBe(URL);
  },
);
