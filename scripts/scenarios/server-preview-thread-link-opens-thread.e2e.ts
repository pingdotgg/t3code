// @effect-diagnostics-next-line nodeBuiltinImport:off - one fixture page for the server's browser to load
import * as NodeHttp from "node:http";

import { expect } from "e2e";

import { environmentId, runPromise, test, WEB } from "./t3.ts";

test(
  "A thread link clicked in the Browser opens that thread",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const target = await t3.thread({ project, title: "Target thread", messages: ["first"] });
    const source = await t3.thread({ project, title: "Source thread", messages: ["first"] });
    const environment = await runPromise(environmentId(app.baseUrl ?? ""));
    // One link that fills the page, so a tap anywhere on the canvas follows it.
    const page = `<!doctype html>
<title>Thread link</title>
<a href="t3-thread://v2/${environment}/${target.threadId}" style="display:block;height:100vh">Open the target thread</a>`;
    const server = NodeHttp.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(page);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No page port.");
      await t3.open(source);

      await screen.getByRole("button", "Toggle right panel").tap();
      await screen.getByRole("button", "Browser B").tap();
      await screen
        .getByRole("textbox", "Search or enter URL")
        .fill(`http://127.0.0.1:${address.port}/`);
      await browser.keyboard.press("Enter");
      await expect(screen.getByText("Thread link")).toBeVisible();
      await app.screenshot("before-click");

      // The page draws on the canvas beside its input proxy.
      await browser.locator('canvas:has(~ textarea[aria-label="Browser page"])').tap();
      try {
        // The app links a thread with its id escaped, while a path typed by hand keeps the colon.
        const id = target.threadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        await expect(browser).toHaveURL(
          new RegExp(`/(?:${id}|${encodeURIComponent(target.threadId)})$`),
        );
      } finally {
        await app.screenshot("after-click");
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
