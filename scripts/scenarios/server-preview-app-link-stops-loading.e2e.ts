// @effect-diagnostics-next-line nodeBuiltinImport:off - one fixture page for the server's browser to load
import * as NodeHttp from "node:http";

import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

// One app link that fills the page. Its click renames the page a moment later, after the server
// has seen the link's request.
const PAGE = `<!doctype html>
<title>Note link</title>
<a href="obsidian://open?vault=demo&amp;file=Note" style="display:block;height:100vh"
  onclick="setTimeout(function () { document.title = 'Link clicked'; }, 500)">Open the note</a>`;

test(
  "An app link clicked in the Browser leaves the page shown and loaded",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const server = NodeHttp.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No page port.");
      const url = `http://127.0.0.1:${address.port}/`;
      const project = await t3.project("demo");
      const thread = await t3.thread({ project, title: "Note check", messages: ["first"] });
      await t3.open(thread);

      await screen.getByRole("button", "Toggle right panel").tap();
      await screen.getByRole("button", "Browser B").tap();
      const addressBar = screen.getByRole("textbox", "Search or enter URL");
      await addressBar.fill(url);
      await browser.keyboard.press("Enter");
      await expect(screen.getByText("Note link")).toBeVisible();

      // The page draws on the canvas beside its input proxy.
      await browser.locator('canvas:has(~ textarea[aria-label="Browser page"])').tap();
      try {
        // Chromium hands the link to the OS and keeps the page, which goes on renaming itself.
        await expect(screen.getByText("Link clicked")).toBeVisible({ timeout: 2_000 });
        await expect(addressBar).toHaveValue(url);
        await expect(screen.getByRole("button", "Refresh", { exact: true })).toBeVisible();
      } finally {
        await app.screenshot("after-click");
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
