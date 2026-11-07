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
<script>const cachedWriteText = navigator.clipboard?.writeText.bind(navigator.clipboard);</script>
<button id="cached" onclick="cachedWriteText('cached').then(() => document.body.dataset.cached = 'yes')">cached</button>
<button id="write" onclick="navigator.clipboard.writeText('written').then(() => document.body.dataset.written = 'yes')">write</button>
<button id="later" onclick="setTimeout(() => navigator.clipboard.writeText('later').then(() => document.body.dataset.later = 'yes'), 50)">later</button>
<button id="exec" onclick="const t = document.createElement('textarea'); t.value = 'executed'; document.body.append(t); t.select(); document.execCommand('copy'); t.remove()">exec</button>
<button id="replace" onclick="document.execCommand(this.dataset.command)">replace</button>
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
    await ServerBrowser.prepareContext(context);
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
    (await ServerBrowser.takeSessionCopies(cdp, click)).find((copy) => copy && copy.text.length > 0)
      ?.text ?? "";
  const inPage = async (expression: string) =>
    (await cdp.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

  it("keeps text the page copies after a real click apart from the copy keys", async () => {
    await page.locator("#write").click();
    expect(await takeCopy(true)).toBe("written");
    await page.locator("body[data-written=yes]").waitFor();
    await page.locator("#cached").click();
    await page.locator("body[data-cached=yes]").waitFor();
    expect(await takeCopy(true)).toBe("cached");
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

  it.each([
    { argument: "123456", text: "123456", outcome: "resolved" },
    { argument: 'new String("boxed")', text: "boxed", outcome: "resolved" },
    {
      argument: 'new URL("https://copy.example/token")',
      text: "https://copy.example/token",
      outcome: "resolved",
    },
    {
      argument: '{ toString() { document.body.dataset.conversions++; return "converted"; } }',
      text: "converted",
      outcome: "resolved",
    },
    { argument: "", text: "", outcome: "TypeError" },
    { argument: 'Symbol("invalid")', text: "", outcome: "TypeError" },
    {
      argument:
        '{ n: 0, toString() { document.body.dataset.conversions++; if (this.n++ === 0) throw conversionError; return "token"; } }',
      text: "",
      outcome: "TypeError",
      conversionFailure: true,
    },
  ])(
    "reports native writeText conversion for $argument",
    async ({ argument, text, outcome, conversionFailure }) => {
      await inPage(`
        document.body.dataset.conversions = "0";
        const conversionError = new TypeError("invalid");
        document.getElementById("write").onclick = () => {
          const writing = navigator.clipboard.writeText(${argument});
          writing.then(
            () => document.body.dataset.outcome = "resolved",
            (error) => {
              document.body.dataset.outcome = error.name;
              document.body.dataset.originalError = String(error === conversionError);
            },
          );
        };
      `);
      await page.locator("#write").click();
      await page.locator("body[data-outcome]").waitFor();
      expect(await inPage("document.body.dataset.outcome")).toBe(outcome);
      expect(await takeCopy(true)).toBe(text);
      expect(await takeCopy(false)).toBe("");
      expect(await inPage("document.body.dataset.conversions")).toBe(
        text === "converted" || conversionFailure ? "1" : "0",
      );
      if (conversionFailure) expect(await inPage("document.body.dataset.originalError")).toBe("true");
    },
  );

  it.each([
    { target: "document", capture: true, format: "text/plain", items: false },
    { target: "document", capture: false, format: "text", items: false },
    { target: "window", capture: true, format: "TEXT/PLAIN", items: false },
    { target: "window", capture: false, format: "Text", items: false },
    { target: "document", capture: true, format: "text/plain", items: true },
  ])(
    "keeps the final copy and cut payload from $target handlers (capture: $capture, items: $items)",
    async ({ target, capture, format, items }) => {
      await inPage(`
        for (const type of ["copy", "cut"]) {
          ${target}.addEventListener(type, (event) => {
            event.preventDefault();
            event.clipboardData.setData("text/plain", "replaced earlier");
            if (!${items}) event.clipboardData.setData("${format}", "page " + event.type);
            event.clipboardData.setData("text/html", "<p>other format</p>");
            if (${items}) {
              event.clipboardData.items.clear();
              event.clipboardData.items.add("page " + event.type, "text/plain");
            }
            if (document.body.dataset.clear === "yes") {
              if (${items}) event.clipboardData.items.clear();
              else event.clipboardData.clearData();
            }
            if (document.body.dataset.clear === "remove") event.clipboardData.items.remove(0);
            event.stopImmediatePropagation();
          }, ${capture});
        }
      `);
      for (const command of ["copy", "cut"]) {
        await page.locator("#text").selectText();
        await inPage(`document.getElementById("replace").dataset.command = "${command}"`);
        await page.locator("#replace").click();
        expect(await takeCopy(true)).toBe(`page ${command}`);
        expect(await takeCopy(false)).toBe("");

        await page.locator("#text").selectText();
        const key = command === "copy" ? "c" : "x";
        const code = command === "copy" ? "KeyC" : "KeyX";
        await cdp.send("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key,
          code,
          modifiers: 4,
          commands: [command],
        });
        expect(await takeCopy(true)).toBe("");
        expect(await takeCopy(false)).toBe(`page ${command}`);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers: 4 });
      }
      await inPage(`document.body.dataset.clear = "yes"`);
      await page.locator("#text").selectText();
      await page.locator("#replace").click();
      expect(await takeCopy(true)).toBe("");
      expect(await takeCopy(false)).toBe("");
      if (items) {
        await inPage(`document.body.dataset.clear = "remove"`);
        await page.locator("#text").selectText();
        await page.locator("#replace").click();
        expect(await takeCopy(true)).toBe("");
        expect(await takeCopy(false)).toBe("");
      }
    },
  );

  it.each([
    { inside: false, data: true },
    { inside: true, data: true },
    { inside: true, data: false },
  ])(
    "keeps a newer writeText over a pending event (inside: $inside, data: $data)",
    async ({ inside, data }) => {
      await inPage(`
        const writeLatest = () => navigator.clipboard.writeText("newest").then(() => {
          document.body.dataset.latest = "yes";
        });
        document.getElementById("replace").onclick = function () {
          document.execCommand(this.dataset.command);
          if (!${inside}) writeLatest();
        };
        for (const type of ["copy", "cut"]) {
          document.addEventListener(type, (event) => {
            event.preventDefault();
            if (${data}) event.clipboardData.setData("text/plain", "older");
            if (${inside}) writeLatest();
            event.stopImmediatePropagation();
          }, true);
        }
      `);
      for (const command of ["copy", "cut"]) {
        await page.locator("#text").selectText();
        await inPage(`
          document.body.removeAttribute("data-latest");
          document.getElementById("replace").dataset.command = "${command}";
        `);
        await page.locator("#replace").click();
        expect(await takeCopy(true)).toBe("newest");
        expect(await takeCopy(false)).toBe("");
        await page.locator("body[data-latest=yes]").waitFor();
        expect(await takeCopy(true)).toBe("");
      }
    },
  );

  it("keeps a pending key copy apart from a later page write", async () => {
    await inPage(`
      document.addEventListener("keydown", () => {
        setTimeout(() => navigator.clipboard.writeText("later page write").then(() => {
          document.body.dataset.latest = "yes";
        }));
      }, true);
      document.addEventListener("copy", (event) => {
        event.preventDefault();
        event.clipboardData.setData("text/plain", "key payload");
        event.stopImmediatePropagation();
      }, true);
    `);
    await page.locator("#plain").click();
    await page.locator("#text").selectText();
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "c",
      code: "KeyC",
      modifiers: 4,
      commands: ["copy"],
    });
    await page.locator("body[data-latest=yes]").waitFor();
    expect(await takeCopy(false)).toBe("key payload");
    expect(await takeCopy(true)).toBe("later page write");
  });

  it("keeps copies delegated from a child frame to its parent", async () => {
    await inPage(`
      globalThis.writeFromChild = async () => {
        await navigator.permissions.query({ name: "clipboard-write" });
        await navigator.clipboard.writeText("delegated");
        document.body.dataset.delegated = "yes";
      };
      globalThis.execFromChild = (command) => {
        const field = document.createElement("textarea");
        field.value = "delegated " + command;
        document.body.append(field);
        field.select();
        document.execCommand(command);
        field.remove();
      };
      const frame = document.createElement("iframe");
      frame.srcdoc = '<button id="write" onclick="parent.writeFromChild()">write</button><button id="copy" onclick="parent.execFromChild(this.id)">copy</button><button id="cut" onclick="parent.execFromChild(this.id)">cut</button>';
      document.body.append(frame);
    `);
    expect(await inPage("navigator.userActivation.hasBeenActive")).toBe(false);
    const frame = page.frameLocator("iframe");
    await frame.locator("#write").click();
    await page.locator("body[data-delegated=yes]").waitFor();
    expect(await takeCopy(true)).toBe("delegated");
    expect(await takeCopy(false)).toBe("");
    for (const command of ["copy", "cut"]) {
      await frame.locator(`#${command}`).click();
      expect(await takeCopy(true)).toBe(`delegated ${command}`);
      expect(await takeCopy(false)).toBe("");
    }
  });

  it.each([
    { kind: "cross-origin", host: "other.example" },
    { kind: "srcdoc", host: "copy.example" },
    { kind: "blank", host: "copy.example" },
    { kind: "opaque", host: "" },
  ])("attributes a $kind frame's copies to its own origin", async ({ kind, host }) => {
    await page.route("https://other.example/", (route) =>
      route.fulfill({ contentType: "text/html", body: PAGE }),
    );
    await inPage(`
      const frame = document.createElement("iframe");
      frame.setAttribute("allow", "clipboard-write");
      if ("${kind}" === "cross-origin") frame.src = "https://other.example/";
      else if ("${kind}" !== "blank") {
        if ("${kind}" === "opaque") frame.setAttribute("sandbox", "allow-scripts");
        frame.srcdoc = ${JSON.stringify(PAGE)};
      }
      document.body.append(frame);
      if ("${kind}" === "blank") {
        frame.contentDocument.open();
        frame.contentDocument.write(${JSON.stringify(PAGE)});
        frame.contentDocument.close();
      }
    `);
    const frame = page.frameLocator("iframe");
    await frame.locator("#exec").waitFor();
    const child = page.frames().find((frame) => frame.parentFrame() === page.mainFrame())!;
    const session = await context.newCDPSession(child).catch(() => cdp);
    await ServerBrowser.recordCopies(session);
    await frame.locator("#exec").click();
    const copies = await ServerBrowser.takeSessionCopies(session, true);
    expect(copies.find((copy) => copy && copy.text.length > 0)).toEqual({ text: "executed", host });
    if (kind !== "opaque") {
      await frame.locator("#cached").click();
      await frame.locator("body[data-cached=yes]").waitFor();
      const cached = await ServerBrowser.takeSessionCopies(session, true);
      expect(cached.find((copy) => copy && copy.text.length > 0)).toEqual({ text: "cached", host });
    }
    expect(await takeCopy(false)).toBe("");
  });

  it("keeps a popup's clipboard function cached before adoption", async () => {
    await context.route("https://other.example/", (route) =>
      route.fulfill({ contentType: "text/html", body: PAGE }),
    );
    await inPage(
      `document.getElementById("plain").onclick = () => window.open("https://other.example/")`,
    );
    const opened = page.waitForEvent("popup");
    await page.locator("#plain").click();
    const popup = await opened;
    await popup.locator("#cached").waitFor();
    const session = await context.newCDPSession(popup);
    await ServerBrowser.recordCopies(session);
    await popup.locator("#cached").click();
    await popup.locator("body[data-cached=yes]").waitFor();
    const copies = await ServerBrowser.takeSessionCopies(session, true);
    expect(copies.find((copy) => copy && copy.text.length > 0)).toEqual({
      text: "cached",
      host: "other.example",
    });
    expect(await takeCopy(false)).toBe("");
  });

  it.each(["right", "middle"] as const)(
    "keeps native %s activation apart from the copy keys",
    async (button) => {
      await inPage(`
        for (const id of ["write", "exec"]) {
          const button = document.getElementById(id);
          button.onmousedown = button.onclick;
        }
      `);
      await page.locator("#write").click({ button });
      await page.locator("body[data-written=yes]").waitFor();
      expect(await takeCopy(true)).toBe("written");
      expect(await takeCopy(false)).toBe("");
      await page.locator("#exec").click({ button });
      expect(await takeCopy(true)).toBe("executed");
      expect(await takeCopy(false)).toBe("");
    },
  );

  it("keeps nothing the page copies without a real click", async () => {
    await inPage(`document.getElementById("write").click()`);
    await inPage(`document.getElementById("exec").click()`);
    await inPage(
      `new Promise((resolve) => setTimeout(() => navigator.clipboard.writeText("timer").then(resolve, resolve)))`,
    );
    await inPage(
      `dispatchEvent(new CustomEvent("t3-preview-clipboard-write", { detail: "forged" }))`,
    );
    await inPage(
      `dispatchEvent(new CustomEvent("t3-preview-clipboard-data", { detail: "forged" }))`,
    );
    expect(await takeCopy(true)).toBe("");
    expect(await takeCopy(false)).toBe("");
    expect(await inPage("typeof globalThis.takeCopy")).toBe("undefined");
    expect(await inPage("navigator.userActivation.hasBeenActive")).toBe(false);
    await page.locator("#plain").click();
    await inPage(
      `dispatchEvent(new CustomEvent("t3-preview-clipboard-data", { detail: "forged after a click" }))`,
    );
    expect(await takeCopy(true)).toBe("");
    expect(await takeCopy(false)).toBe("");
  });
});
