// @effect-diagnostics-next-line nodeBuiltinImport:off - one fixture page for the server's browser to load
import * as NodeHttp from "node:http";

import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

// A page that renames itself on a click, with no navigation.
const PAGE = `<!doctype html>
<title>Original title</title>
<body style="margin:0;height:100vh" onpointerdown="document.title = 'Updated title'">
  Click to rename
</body>`;

test(
  "A Browser tab's label follows a title change that makes no navigation",
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
      const project = await t3.project("demo");
      const thread = await t3.thread({ project, title: "Rename check", messages: ["first"] });
      await t3.open(thread);

      await screen.getByRole("button", "Toggle right panel").tap();
      await screen.getByRole("button", "Browser B").tap();
      await screen
        .getByRole("textbox", "Search or enter URL")
        .fill(`http://127.0.0.1:${address.port}/`);
      await browser.keyboard.press("Enter");
      await expect(screen.getByText("Original title")).toBeVisible();

      // The page draws on the canvas beside its input proxy.
      await browser.locator('canvas:has(~ textarea[aria-label="Browser page"])').tap();
      await expect(screen.getByText("Updated title")).toBeVisible();
      await app.screenshot("after-title-change");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
