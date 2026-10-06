import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";

describe("server browser element refs", () => {
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
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
  });
  afterEach(async () => {
    await context.close();
  });

  const takeSnapshot = () =>
    ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
  const locators = (tree: unknown) => {
    expect(typeof tree).toBe("string");
    return Array.from(
      String(tree).matchAll(/\[ref=([^\]]+)\]/g),
      (match) => `aria-ref=${match[1]}`,
    );
  };
  const buttonLocator = (tree: unknown, name: string) => {
    const line = String(tree)
      .split("\n")
      .find((line) => line.includes(`button "${name}"`));
    const locator = locators(line)[0];
    expect(locator).toBeDefined();
    return locator!;
  };
  const repeatedRows = `<ul>${Array.from({ length: 5 }, (_, i) => `<li>row ${i + 1}<button data-testid="delete-row" onclick="this.parentElement.remove()">delete</button></li>`).join("")}</ul>`;

  it("clicks the fifth repeated delete control without touching row one", async () => {
    await page.setContent(repeatedRows);
    const result = await takeSnapshot();
    const buttons = String(result.accessibilityTree)
      .split("\n")
      .filter((line) => line.includes('button "delete"'));
    expect(buttons).toHaveLength(5);
    await ServerBrowserPage.click(page, { locator: locators(buttons[4])[0]!, timeoutMs: 1_000 });
    expect(await page.locator("li").allTextContents()).toEqual([
      "row 1delete",
      "row 2delete",
      "row 3delete",
      "row 4delete",
    ]);
  });

  it("returns from a click once it opens a dialog", async () => {
    await page.setContent(
      `<button onclick="document.body.dataset.answer = String(confirm('sure?'))">Confirm</button>`,
    );
    const dialog = new Promise<import("playwright-core").Dialog>((resolve) =>
      page.once("dialog", resolve),
    );
    await ServerBrowserPage.click(page, {
      locator: buttonLocator((await takeSnapshot()).accessibilityTree, "Confirm"),
      timeoutMs: 1_000,
    });
    await (await dialog).accept();
    await expect.poll(() => page.locator("body").getAttribute("data-answer")).toBe("true");
  });

  it("rejects ambiguous CSS controls without clicking any row", async () => {
    await page.setContent(repeatedRows);
    await expect(
      ServerBrowserPage.click(page, {
        selector: 'button[data-testid="delete-row"]',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/strict mode violation/);
    expect(await page.locator("li").count()).toBe(5);
  });

  it("does not retarget a removed ref to a replacement node", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">original</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "original");
    await page.setContent("<button onclick=\"this.textContent='clicked'\">replacement</button>");
    await expect(ServerBrowserPage.click(page, { locator, timeoutMs: 100 })).rejects.toThrow();
    expect(await page.locator("button").textContent()).toBe("replacement");
  });

  it("targets iframe input refs and preserves the parent form", async () => {
    await page.setContent(
      '<input aria-label="parent"><iframe srcdoc="<input aria-label=child>"></iframe>',
    );
    await page.frameLocator("iframe").getByRole("textbox").waitFor();
    const result = await takeSnapshot();
    const line = String(result.accessibilityTree)
      .split("\n")
      .find((line) => line.includes('textbox "child"'));
    const locator = locators(line)[0]!;
    await ServerBrowserPage.type(page, { locator, text: "inside iframe", clear: true });
    expect(await page.frameLocator("iframe").getByRole("textbox").inputValue()).toBe(
      "inside iframe",
    );
    expect(await page.getByRole("textbox", { name: "parent" }).inputValue()).toBe("");
  });

  it("rejects refs from another tab", async () => {
    await page.setContent("<button>same label</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "same label");
    const other = await context.newPage();
    await other.setContent("<button>same label</button>");
    await expect(ServerBrowserPage.click(other, { locator })).rejects.toThrow(/another tab/);
  });

  it("revokes refs on takeover and issues usable refs in the next snapshot", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    ServerBrowserPage.invalidateRefs(page);
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
    const fresh = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await ServerBrowserPage.click(page, { locator: fresh });
    expect(await page.locator("button").textContent()).toBe("clicked");
  });

  it("revokes refs after navigation even when labels are identical", async () => {
    await page.goto("data:text/html,<button>continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await page.goto("data:text/html,<button>continue</button><p>new document</p>");
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
  });

  it("only accepts refs from the most recent snapshot", async () => {
    await page.setContent("<button>continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await takeSnapshot();
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
  });

  it.each(["aria-ref=e1", " aria-ref=e1", "css=body >> aria-ref=e1"])(
    "does not allow native refs to bypass generation validation (%s)",
    async (locator) => {
      await page.setContent("<button>continue</button>");
      await takeSnapshot();
      await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
    },
  );

  it("preserves CSS selectors containing an aria-ref attribute", async () => {
    await page.setContent(
      '<button aria-ref="save" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[aria-ref="save"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
  });

  it("preserves quoted attribute values containing ref engine text", async () => {
    await page.setContent(
      '<button data-example=" >> aria-ref=e1" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[data-example=" >> aria-ref=e1"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
  });

  it("right-clicks, double-clicks, hovers, selects, and drags like a pointer user", async () => {
    await page.setContent(`
      <style>#menu { position: absolute; display: none } #hover:hover + #menu { display: block }</style>
      <button id="target">target</button>
      <div id="hover">hover me</div><div id="menu">menu item</div>
      <select id="size"><option value="s">Small</option><option value="l">Large</option></select>
      <div id="card" draggable="true">card</div><div id="lane" style="height:40px">lane</div>
      <p id="log"></p>
      <script>
        const log = (text) => (document.getElementById("log").textContent += text + ";");
        const target = document.getElementById("target");
        target.addEventListener("contextmenu", (event) => { event.preventDefault(); log("context"); });
        target.addEventListener("dblclick", () => log("dblclick"));
        document.getElementById("card").addEventListener("dragstart", (event) =>
          event.dataTransfer.setData("text/plain", "card"),
        );
        for (const type of ["dragenter", "dragover"])
          document.getElementById("lane").addEventListener(type, (event) => event.preventDefault());
        document.getElementById("lane").addEventListener("drop", () => log("drop"));
      </script>`);
    await ServerBrowserPage.click(page, { locator: "#target", button: "right" });
    await ServerBrowserPage.click(page, { locator: "#target", clickCount: 2 });
    await ServerBrowserPage.hover(page, { locator: "#hover" });
    expect(await page.isVisible("#menu")).toBe(true);
    // A visible label selects the same option as its value.
    expect(await ServerBrowserPage.select(page, { locator: "#size", values: ["Large"] })).toEqual({
      selected: ["l"],
    });
    await ServerBrowserPage.drag(page, { source: "#card", target: "#lane" });
    expect(await page.textContent("#log")).toBe("context;dblclick;drop;");
    await expect(
      ServerBrowserPage.select(page, { locator: "#target", values: ["s"] }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTargetNotEditableError" });
  });

  it("shows the agent's pointer at each target before the action reaches the page", async () => {
    await page.setContent(`
      <button id="go" style="position:absolute;left:100px;top:40px;width:80px;height:20px">go</button>
      <div id="tip" style="position:absolute;left:300px;top:40px;width:60px;height:20px">tip</div>
      <div id="card" draggable="true" style="position:absolute;left:20px;top:120px;width:40px;height:40px">card</div>
      <div id="lane" style="position:absolute;left:220px;top:120px;width:100px;height:40px">lane</div>
      <script>
        window.seen = [];
        go.onclick = () => seen.push("click");
        tip.onmouseenter = () => seen.push("hover");
        card.ondragstart = (event) => event.dataTransfer.setData("text/plain", "card");
        lane.ondragover = (event) => event.preventDefault();
        lane.ondrop = () => seen.push("drop");
      </script>`);
    const shown: Array<string> = [];
    const pointer: ServerBrowserPage.PointerReporter = async ({ x, y }, phase) => {
      const seen = await page.evaluate("window.seen.length");
      shown.push(`${phase}@${Math.round(x)},${Math.round(y)} after ${seen}`);
    };
    await ServerBrowserPage.click(page, { locator: "#go" }, pointer);
    await ServerBrowserPage.hover(page, { locator: "#tip" }, pointer);
    await ServerBrowserPage.drag(page, { source: "#card", target: "#lane" }, pointer);
    expect(shown).toEqual([
      "click@140,50 after 0",
      "move@330,50 after 1",
      "move@40,140 after 2",
      "move@270,140 after 2",
    ]);
    expect(await page.evaluate("window.seen")).toEqual(["click", "hover", "drop"]);
  });
});
