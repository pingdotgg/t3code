/// <reference lib="dom" />
// @effect-diagnostics-next-line nodeBuiltinImport:off - fixture pages for the server's browser
import * as NodeHttp from "node:http";

import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Browser history keeps visits from both open tabs after a reload",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const server = NodeHttp.createServer((request, response) => {
      const title = request.url === "/first" ? "First preview visit" : "Second preview visit";
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><title>${title}</title><p>${title}</p>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No page port.");
      const host = `127.0.0.1:${address.port}`;
      const origin = `http://${host}`;
      const project = await t3.project("demo");
      const first = await t3.thread({ project, title: "First browser", messages: ["first"] });
      const second = await t3.thread({ project, title: "Second browser", messages: ["second"] });
      const history = await t3.thread({ project, title: "History check", messages: ["third"] });
      await t3.open(first);

      // Load the second app before either visit, with an independent store and shared storage.
      await browser.evaluate((threadId) => {
        const frame = document.createElement("iframe");
        frame.id = "second-client";
        frame.src = location.pathname.replace(/[^/]+$/, threadId);
        frame.style.cssText =
          "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647";
        document.body.append(frame);
        return null;
      }, second.threadId);
      const other = browser.frameLocator("#second-client");
      await other.getByRole("button", "Toggle right panel").tap();
      await other.getByRole("button", "Browser B").tap();
      const otherAddress = other.getByRole("textbox", "Search or enter URL");
      await otherAddress.waitFor();
      await browser.evaluate(() => {
        document.querySelector<HTMLIFrameElement>("#second-client")!.style.display = "none";
        return null;
      });

      await screen.getByRole("button", "Toggle right panel").tap();
      await screen.getByRole("button", "Browser B").tap();
      await screen.getByRole("textbox", "Search or enter URL").fill(`${origin}/first`);
      await browser.keyboard.press("Enter");
      await screen.getByText("First preview visit", { exact: true }).waitFor();

      await browser.evaluate(() => {
        document.querySelector<HTMLIFrameElement>("#second-client")!.style.display = "";
        return null;
      });
      await otherAddress.fill(`${origin}/second`);
      await browser.keyboard.press("Enter");
      await other.getByText("Second preview visit", { exact: true }).waitFor();

      const historyUrl = new URL(await browser.url());
      historyUrl.pathname = historyUrl.pathname.replace(/[^/]+$/, history.threadId);
      await app.open(historyUrl.pathname);
      await screen.getByRole("button", "Toggle right panel").tap();
      await screen.getByRole("button", "Browser B").tap();
      await screen.getByText(`${host}/second`, { exact: false }).waitFor();
      await app.screenshot("browser-history-after-both-visits");
      await expect(screen.getByText(`${host}/first`, { exact: false })).toBeVisible();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
