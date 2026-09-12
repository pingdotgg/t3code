import { expect, test as base, type Page } from "@playwright/test";
import { build } from "vite-plus";
import type * as Visualization from "../src/html-visualization";

declare global {
  interface Window {
    T3Visualization: typeof Visualization;
    visualizationMessages: unknown[];
  }
}

const APP_URL = "https://visualization.test/";
let bundle: string;

const test = base.extend<{ unexpectedRequests: string[] }>({
  unexpectedRequests: [
    async ({ page }, use) => {
      const requests: string[] = [];
      await page.route("**/*", async (route) => {
        if (route.request().url() === APP_URL && route.request().isNavigationRequest()) {
          await route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><title>Visualization security tests</title><body><p id="parent">Parent document</p></body>',
          });
        } else {
          requests.push(route.request().url());
          await route.abort();
        }
      });
      await page.goto(APP_URL);
      await page.addScriptTag({ content: bundle });
      await page.evaluate(() => {
        localStorage.setItem("visualization-test-secret", "parent-only");
        window.visualizationMessages = [];
        addEventListener(
          "message",
          (event) =>
            window.T3Visualization.parseVisualizationHeight(event.data) === null &&
            window.visualizationMessages.push(event.data),
        );
      });
      await use(requests);
      expect(requests, "visualization must not initiate network requests").toEqual([]);
    },
    { auto: true },
  ],
});

test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    build: {
      write: false,
      lib: { entry: "src/html-visualization.ts", formats: ["iife"], name: "T3Visualization" },
      minify: false,
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !("output" in output)) throw new Error("Visualization bundle was not emitted");
  const chunk = output.output.find((entry) => entry.type === "chunk");
  if (!chunk) throw new Error("Visualization bundle contains no JavaScript");
  bundle = chunk.code;
});

async function mountVisualization(page: Page, html: string, themeCSS = "") {
  await page.evaluate(
    ({ source, theme }) => {
      const frame = document.createElement("iframe");
      frame.id = "visualization";
      frame.title = "Visualization";
      frame.sandbox.value = "allow-scripts";
      frame.style.cssText = "display:block;width:480px;height:320px;border:0";
      frame.srcdoc = window.T3Visualization.visualizationDocument(source, false, theme);
      addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const height = window.T3Visualization.parseVisualizationHeight(event.data);
        if (height !== null) frame.style.height = `${height}px`;
      });
      document.body.append(frame);
    },
    { source: html, theme: themeCSS },
  );
  const content = page.frameLocator("#visualization").frameLocator("iframe");
  await expect(content.locator("body")).toBeVisible();
  return content;
}

test("preserves full-document styles and native interactions", async ({
  page,
  unexpectedRequests,
}) => {
  const content = await mountVisualization(
    page,
    `<!doctype html><html><head>
    <style>.result { color: rgb(12, 34, 56) } #show:checked ~ .result { font-weight: 700 }</style>
    </head><body><details><summary>More information</summary><p>Expanded content</p></details>
    <input id="show" type="checkbox"><label for="show">Highlight result</label>
    <p class="result">Result</p></body></html>`,
  );
  await expect(content.getByText("Expanded content")).toBeHidden();
  await content.getByText("More information").click();
  await expect(content.getByText("Expanded content")).toBeVisible();
  await content.getByLabel("Highlight result").check();
  await expect(content.locator(".result")).toHaveCSS("color", "rgb(12, 34, 56)");
  await expect(content.locator(".result")).toHaveCSS("font-weight", "700");
  await content.getByLabel("Highlight result").uncheck();
  await content.getByText("More information").click();
  await expect(content.getByText("Expanded content")).toBeHidden();
  expect(unexpectedRequests).toEqual([]);
});

test("removes scripts, hints, nested documents, and navigation attributes", async ({
  page,
  unexpectedRequests,
}) => {
  const content = await mountVisualization(
    page,
    `
    <script>top.postMessage('script escaped', '*'); top.document.body.textContent = 'escaped';</script>
    <LiNk rel="dns-prefetch" href="https://dns.example.invalid">
    <link rel="preconnect" href="https://connect.example.invalid">
    <iframe srcdoc="&lt;link rel=preconnect href=https://nested.example.invalid&gt;"></iframe>
    <object data="https://object.example.invalid"></object><embed src="https://embed.example.invalid">
    <meta http-equiv="refresh" content="0;url=https://refresh.example.invalid">
    <base href="https://base.example.invalid/">
    <template><link rel="dns-prefetch" href="https://template.example.invalid"></template>
    <img src="https://image.example.invalid" srcset="https://srcset.example.invalid 1x" onerror="top.postMessage('handler escaped','*')">
    <a href="https://navigate.example.invalid" ping="https://ping.example.invalid" target="_top">Navigation probe</a>
    <a href="https://popup.example.invalid" target="_blank">Popup probe</a>
    <form action="https://form.example.invalid"><input autofocus><button formaction="https://button.example.invalid">Submit probe</button></form>`,
  );
  await expect(
    content.locator("body script, link, iframe, object, embed, base, body meta"),
  ).toHaveCount(0);
  await expect(
    content.locator(
      "[href], [src], [srcset], [action], [formaction], [ping], [autofocus], [onerror]",
    ),
  ).toHaveCount(0);
  expect(
    await content
      .locator("template")
      .evaluate((node) => (node as HTMLTemplateElement).content.childElementCount),
  ).toBe(0);
  await content.getByText("Navigation probe").click();
  await content.getByText("Popup probe").click();
  await content.getByRole("button", { name: "Submit probe" }).click();
  await expect(page.locator("#parent")).toHaveText("Parent document");
  await expect(page).toHaveURL(APP_URL);
  expect(page.context().pages()).toHaveLength(1);
  expect(await page.evaluate(() => window.visualizationMessages)).toEqual([]);
  expect(unexpectedRequests).toEqual([]);
});

test("blocks CSS resource requests while preserving the visualization", async ({
  page,
  unexpectedRequests,
}) => {
  const content = await mountVisualization(
    page,
    `<style>
    @import url("https://import.example.invalid/style.css");
    @font-face { font-family: probe; src: url("https://font.example.invalid/font.woff2") }
    .probe { background-image: url("https://background.example.invalid/image"); font-family: probe; color: rgb(1, 2, 3) }
    </style><p class="probe">CSS resource probe</p>`,
  );
  await expect(content.getByText("CSS resource probe")).toHaveCSS("color", "rgb(1, 2, 3)");
  await content.locator("body").evaluate(async () => {
    await document.fonts.ready;
  });
  expect(unexpectedRequests).toEqual([]);
});

test("enforces sandbox and CSP even if active markup reaches the document", async ({
  page,
  unexpectedRequests,
}) => {
  const content = await mountVisualization(page, "<p>Runtime boundary probe</p>");
  const imageBlocked = page.waitForEvent("console", {
    predicate: (message) =>
      message.text().includes("runtime-image.example.invalid") &&
      message.text().includes("Content Security Policy"),
  });
  // Browser automation inserts this after sanitization to exercise the independent runtime boundary.
  await content.locator("body").evaluate((body) => {
    const script = document.createElement("script");
    script.textContent = "top.postMessage('runtime script escaped', '*')";
    body.append(script);
    body.insertAdjacentHTML(
      "beforeend",
      `
      <button onclick="top.postMessage('runtime handler escaped', '*')">Handler probe</button>
      <a href="https://runtime-top.example.invalid" target="_top">Top navigation</a>
      <form action="https://runtime-form.example.invalid"><button>Runtime submit</button></form>
      <a href="https://runtime-self.example.invalid">Self navigation</a>`,
    );
    const image = document.createElement("img");
    image.src = "https://runtime-image.example.invalid/image";
    body.append(image);
  });
  await imageBlocked;
  await content.getByRole("button", { name: "Handler probe" }).click();
  await content.getByText("Top navigation").click();
  await content.getByRole("button", { name: "Runtime submit" }).click();
  await expect(content.getByText("Runtime boundary probe")).toBeVisible();
  const navigationBlocked = page.waitForEvent("console", {
    predicate: (message) =>
      message.text().includes("runtime-self.example.invalid") &&
      message.text().includes("frame-src"),
  });
  await content.getByText("Self navigation").click();
  await navigationBlocked;
  await expect(page).toHaveURL(APP_URL);
  await expect(page.locator("#parent")).toHaveText("Parent document");
  expect(await page.evaluate(() => window.visualizationMessages)).toEqual([]);
  expect(unexpectedRequests).toEqual([]);
});

test("sanitizes malformed SVG and MathML across browser reparsing", async ({
  page,
  unexpectedRequests,
}) => {
  const content = await mountVisualization(
    page,
    `
    <svg><foreignObject><link rel="preconnect" href="https://foreign.example.invalid"></foreignObject>
    <a xlink:href="https://svg.example.invalid"><text>Safe SVG text</text></a><circle cx="10" cy="10" r="5"/></svg>
    <math><mtext><table><mglyph><style><!--</style><img title="--><link rel=preconnect href=https://mutation.example.invalid>"></table></mtext></math>
    <p>Parser survived</p>`,
  );
  await expect(content.getByText("Parser survived")).toBeVisible();
  await expect(content.locator("svg circle")).toHaveCount(1);
  await expect(
    content.locator("link, iframe, foreignObject, [href], [xlink\\:href], [src]"),
  ).toHaveCount(0);
  expect(unexpectedRequests).toEqual([]);
});

test("keeps parent DOM and storage inaccessible and oversized content clipped", async ({
  page,
  unexpectedRequests,
}) => {
  const content = await mountVisualization(
    page,
    `"></iframe>
    <div style="height:20000px">Tall content</div><div style="position:fixed;inset:0;width:10000px;height:10000px;background:red">Contained content</div>`,
  );
  const isolation = await content.locator("body").evaluate(() => {
    const denied = (read: () => unknown) => {
      try {
        read();
        return false;
      } catch (error) {
        return error instanceof DOMException && error.name === "SecurityError";
      }
    };
    return {
      parent: denied(() => parent.document.body),
      top: denied(() => top!.document.body),
      localStorage: denied(() => localStorage.getItem("visualization-test-secret")),
      sessionStorage: denied(() => sessionStorage.length),
    };
  });
  expect(isolation).toEqual({ parent: true, top: true, localStorage: true, sessionStorage: true });
  await expect(page.locator("body > iframe")).toHaveCount(1);
  await expect(page.locator("#parent")).toHaveText("Parent document");
  await expect(page.locator("#visualization")).toHaveCSS("height", "10000px");
  expect(await page.locator("#visualization").boundingBox()).toMatchObject({
    width: 480,
    height: 10000,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(900);
  expect(unexpectedRequests).toEqual([]);
});

test("fits native interactions in both directions and preserves state across theme changes", async ({
  page,
}) => {
  const content = await mountVisualization(
    page,
    `
    <style>body{background:red;padding:40px;margin:40px}.extra{display:none;height:240px}#toggle:checked ~ .extra{display:block}p{margin:0}</style>
    <input type="checkbox" id="toggle"><label for="toggle">Show graph</label><div class="extra">Graph</div>
    <details><summary>Breakdown</summary><div style="height:180px">Details</div></details>
    <p>Theme text</p>`,
    "--foreground:rgb(12, 34, 56);font-family:monospace;font-size:16px;line-height:24px",
  );
  const frame = page.locator("#visualization");
  await expect(content.getByText("Theme text")).toHaveCSS("color", "rgb(12, 34, 56)");
  await expect(content.locator("body")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(content.locator("body")).toHaveCSS("margin", "0px");
  await expect(content.locator("body")).toHaveCSS("padding", "0px");
  await expect(content.locator("body")).toHaveCSS("font-family", "monospace");
  await expect.poll(async () => (await frame.boundingBox())!.height).toBeLessThan(150);
  const initialHeight = (await frame.boundingBox())!.height;
  await content.getByLabel("Show graph").check();
  await expect.poll(async () => (await frame.boundingBox())!.height).toBe(initialHeight + 240);
  await content.getByText("Breakdown").click();
  await expect.poll(async () => (await frame.boundingBox())!.height).toBe(initialHeight + 420);
  await frame.evaluate((node) =>
    (node as HTMLIFrameElement).contentWindow!.postMessage(
      { type: "t3-visualization-theme", css: "--foreground:rgb(65, 43, 21);color-scheme:dark" },
      "*",
    ),
  );
  await expect(content.getByText("Theme text")).toHaveCSS("color", "rgb(65, 43, 21)");
  await expect(content.getByLabel("Show graph")).toBeChecked();
  await expect(content.getByText("Details", { exact: true })).toBeVisible();
  await content.getByLabel("Show graph").uncheck();
  await content.getByText("Breakdown").click();
  await expect.poll(async () => (await frame.boundingBox())!.height).toBe(initialHeight);
  await frame.evaluate((node) => {
    (node as HTMLIFrameElement).style.width = "240px";
  });
  await expect(content.locator("body")).toHaveCSS("width", "240px");
  expect(await content.locator("body").evaluate(() => document.documentElement.scrollWidth)).toBe(
    240,
  );
});

test("rejects spoofed resize and theme messages and resists named DOM clobbering", async ({
  page,
}) => {
  const content = await mountVisualization(
    page,
    `<form id="content" name="parent"><input name="postMessage"><input name="ResizeObserver"></form><p id="theme">Still isolated</p>`,
    "--foreground:rgb(12, 34, 56)",
  );
  const frame = page.locator("#visualization");
  await expect.poll(async () => (await frame.boundingBox())!.height).toBeLessThan(150);
  const height = (await frame.boundingBox())!.height;
  await page.evaluate(() => {
    const target = document.querySelector<HTMLIFrameElement>("#visualization")!.contentWindow!;
    window.postMessage({ type: "t3-visualization-height", height: 9000 }, "*");
    target.postMessage({ type: "t3-visualization-height", height: 9000 }, "*");
    // The top window is not the inner frame's direct parent.
    target.frames[0]!.postMessage({ type: "t3-visualization-theme", css: "--foreground:red" }, "*");
    target.postMessage(
      { type: "t3-visualization-theme", css: "--foreground:red;" + " ".repeat(16000) },
      "*",
    );
  });
  await content
    .locator("body")
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  expect((await frame.boundingBox())!.height).toBe(height);
  await expect(content.getByText("Still isolated")).toHaveCSS("color", "rgb(12, 34, 56)");
  expect(
    await page.evaluate(() =>
      [
        null,
        {},
        { type: "t3-visualization-height", height: NaN },
        { type: "t3-visualization-height", height: Infinity },
        { type: "t3-visualization-height", height: 10001 },
        { type: "t3-visualization-height", height: 0 },
        { type: "t3-visualization-height", height: "200" },
      ].map(window.T3Visualization.parseVisualizationHeight),
    ),
  ).toEqual([null, null, null, null, null, null, null]);
});

test("embeds initial theme declarations without allowing style-element breakout", async ({
  page,
}) => {
  const content = await mountVisualization(
    page,
    "<p>Theme boundary</p>",
    '--foreground:rgb(12, 34, 56);--probe:"</style><script>top.postMessage("theme escaped","*")</script>"',
  );
  await expect(content.getByText("Theme boundary")).toHaveCSS("color", "rgb(12, 34, 56)");
  await expect(content.locator("body script")).toHaveCount(0);
  expect(await page.evaluate(() => window.visualizationMessages)).toEqual([]);
});
