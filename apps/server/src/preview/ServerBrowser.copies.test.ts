import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import * as ServerBrowser from "./ServerBrowser.ts";

const PAGE = `<!doctype html>
<button id="write" onclick="navigator.clipboard.writeText('written').then(() => document.body.dataset.written = 'yes')">write</button>
<button id="later" onclick="setTimeout(() => navigator.clipboard.writeText('later').then(() => document.body.dataset.later = 'yes'), 50)">later</button>
<button id="exec" onclick="const t = document.createElement('textarea'); t.value = 'executed'; document.body.append(t); t.select(); document.execCommand('copy'); t.remove()">exec</button>
<button id="plain">plain</button>
<p id="text">selected</p>`;

describe("server browser page copies", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    await context.grantPermissions(["clipboard-write"]);
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    await ServerBrowser.recordCopies(cdp);
    await page.route("https://copy.example/", (route) =>
      route.fulfill({ contentType: "text/html", body: PAGE }),
    );
    await page.goto("https://copy.example/");
  });
  afterEach(async () => {
    await context.close();
  });

  const takeCopy = async (click: boolean) =>
    (await ServerBrowser.takeSessionCopies(cdp, click)).find((text) => text.length > 0) ?? "";
  const inPage = async (expression: string) =>
    (await cdp.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

  it("keeps text the page copies after a real click apart from the copy keys", async () => {
    await page.locator("#write").click();
    expect(await takeCopy(true)).toBe("written");
    await page.locator("body[data-written=yes]").waitFor();
    await page.locator("#later").click();
    await page.locator("body[data-later=yes]").waitFor();
    expect(await takeCopy(true)).toBe("later");
    await page.locator("#exec").click();
    expect(await takeCopy(true)).toBe("executed");
    await page.locator("#plain").click();
    expect(await takeCopy(true)).toBe("");

    await page.locator("#text").selectText();
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "c",
      code: "KeyC",
      modifiers: 4,
      commands: ["copy"],
    });
    expect(await takeCopy(true)).toBe("");
    expect(await takeCopy(false)).toBe("selected");
  });

  it("keeps nothing the page copies without a real click", async () => {
    await inPage(`document.getElementById("write").click()`);
    await inPage(`document.getElementById("exec").click()`);
    await inPage(
      `new Promise((resolve) => setTimeout(() => navigator.clipboard.writeText("timer").then(resolve, resolve)))`,
    );
    await inPage(
      `dispatchEvent(new CustomEvent("t3-preview-clipboard-write", { detail: "forged" }))`,
    );
    expect(await takeCopy(true)).toBe("");
    expect(await takeCopy(false)).toBe("");
    expect(await inPage("typeof globalThis.takeCopy")).toBe("undefined");
    expect(await inPage("navigator.userActivation.hasBeenActive")).toBe(false);
  });
});
