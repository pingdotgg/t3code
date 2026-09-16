import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { chromium } from "playwright-core";

const repo = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
const temporary = NodeFS.mkdtempSync(`${NodeOS.tmpdir()}/t3-design-check-`);
const bundle = `${temporary}/preload.cjs`;
NodeChildProcess.execFileSync(
  `${repo}node_modules/.bin/esbuild`,
  [
    "apps/desktop/src/preview/DesignPreload.ts",
    "--bundle",
    "--platform=browser",
    "--format=cjs",
    "--external:electron",
    `--outfile=${bundle}`,
  ],
  { cwd: repo },
);
const source = NodeFS.readFileSync(bundle, "utf8");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  headless: true,
  args: ["--no-sandbox"],
});
const installEditor = (source) => {
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (options) {
    return attach.call(this, { ...options, mode: "open" });
  };
  const handlers = new Map();
  window.designSaves = [];
  const ipcRenderer = {
    on: (name, fn) => handlers.set(name, fn),
    send: (_name, payload) => window.designSaves.push(payload),
    removeListener: () => {},
  };
  new Function("require", "module", "exports", source)(() => ({ ipcRenderer }), {}, {});
  handlers.get("preview:set-design-editing")({}, true);
};

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const client = await page.context().newCDPSession(page);
  let layers = [];
  client.on("LayerTree.layerTreeDidChange", (event) => {
    layers = event.layers ?? [];
  });
  await client.send("LayerTree.enable");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><style>body{margin:24px;font:16px system-ui;background:#f8f9fb}main{display:flex;gap:48px}section{width:600px;height:500px;background:white;padding:40px;flex:none;box-sizing:border-box}p{width:200px}</style><main><section data-t3-design-artboard="Account"><h1>Account settings</h1><p id="target">Before</p></section><section data-t3-design-artboard="Profile"><h1>Profile settings</h1></section></main>',
    }),
  );
  await page.goto(
    "http://127.0.0.1/api/assets/test?t3-design=1&t3-design-path=.t3/designs/test.html",
  );
  await page.evaluate(installEditor, source);
  NodeAssert.equal(
    await page.getByRole("button", { name: "Hand (H)", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  NodeAssert.equal(await page.locator("[data-t3-design-focus]").count(), 0);
  const menu = page.getByLabel("Canvas menu", { exact: true });
  await menu.click();
  NodeAssert.equal(
    await page.getByRole("button", { name: "Export HTML", exact: true }).isVisible(),
    true,
  );
  await menu.click();
  NodeAssert.equal(
    await page.getByRole("button", { name: "Export HTML", exact: true }).isVisible(),
    false,
  );
  const target = page.locator("#target");
  const before = await target.boundingBox();
  await page.keyboard.down("Space");
  await page.mouse.move(700, 700);
  await page.mouse.down();
  await page.mouse.move(820, 760, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  const panned = await target.boundingBox();
  const { root: domRoot } = await client.send("DOM.getDocument");
  const { nodeId } = await client.send("DOM.querySelector", {
    nodeId: domRoot.nodeId,
    selector: "body",
  });
  const { node } = await client.send("DOM.describeNode", { nodeId });
  NodeAssert.ok(
    layers.some((layer) => layer.backendNodeId === node.backendNodeId && layer.drawsContent),
    "the design has its own rendering layer while panning",
  );
  NodeAssert.ok(Math.abs(panned.x - before.x - 120) < 1);
  NodeAssert.ok(Math.abs(panned.y - before.y - 60) < 1);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  NodeAssert.ok((await target.boundingBox()).width > panned.width);
  await page.keyboard.press("Shift+1");
  await page.getByRole("button", { name: "Select (V)", exact: true }).click();
  const fitted = await target.boundingBox();
  await page.mouse.move(fitted.x + 20, fitted.y + 10);
  await page.mouse.down();
  await page.mouse.move(fitted.x + 80, fitted.y + 50, { steps: 8 });
  await page.mouse.up();
  const moved = await target.boundingBox();
  NodeAssert.ok(
    Math.abs(moved.x - fitted.x - 60) < 1,
    "first drag moves the element at the current zoom",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  NodeAssert.ok(Math.abs((await target.boundingBox()).x - fitted.x) < 1);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  NodeAssert.ok(Math.abs((await target.boundingBox()).x - moved.x) < 1);
  const profileBoard = await page.locator('[data-t3-design-artboard="Profile"]').boundingBox();
  await page.mouse.move(moved.x + 20, moved.y + 10);
  await page.mouse.down();
  await page.mouse.move(profileBoard.x + 40, moved.y + 10, { steps: 6 });
  await page.mouse.move(profileBoard.x + 23, moved.y + 10, { steps: 3 });
  NodeAssert.ok(
    (await page.locator(".guide:not([hidden])").count()) > 0,
    "a smart guide appears near an aligned edge",
  );
  await page.mouse.up();
  NodeAssert.ok(
    Math.abs((await target.boundingBox()).x - profileBoard.x) < 0.5,
    "the drag snaps onto the artboard edge",
  );
  NodeAssert.equal(await page.locator(".guide:not([hidden])").count(), 0);
  await page.keyboard.press("Control+z");
  const properties = page.getByRole("complementary", { name: "Design", exact: true });
  const editToggle = page.getByRole("button", { name: "Edit", exact: true });
  NodeAssert.equal(await properties.isVisible(), false);
  await editToggle.click();
  NodeAssert.equal(await editToggle.getAttribute("aria-pressed"), "true");
  const layerRows = page.locator(".layer-row");
  NodeAssert.ok((await layerRows.count()) >= 3, "the properties panel lists layers");
  NodeAssert.equal(await page.locator(".layer .layer-tag").first().textContent(), "main");
  const collapsedRows = await layerRows.count();
  await layerRows
    .filter({ hasText: "Profile" })
    .first()
    .getByRole("button", { name: "Expand children", exact: true })
    .click();
  NodeAssert.ok((await layerRows.count()) > collapsedRows, "a collapsed layer row expands");
  await page.getByRole("button", { name: "Use this design", exact: true }).click();
  NodeAssert.equal(
    await page
      .locator('[data-t3-design-artboard="Account"]')
      .getAttribute("data-t3-design-selected"),
    "true",
  );
  await page.getByRole("button", { name: "Selected for build", exact: true }).waitFor();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  NodeAssert.ok(
    (await page.evaluate(() => window.designSaves.at(-1).html)).includes(
      'data-t3-design-selected="true"',
    ),
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Use this design", exact: true }).waitFor();
  NodeAssert.equal(await page.locator("[data-t3-design-selected]").count(), 0);
  await page.keyboard.down("Space");
  await page.mouse.move(700, 700);
  await page.mouse.down();
  await page.mouse.move(1000, 700, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await target.dblclick();
  NodeAssert.ok(
    await page.locator(".text-toolbar").isVisible(),
    "the inline text toolbar shows while editing",
  );
  NodeAssert.equal(
    await page.locator(".tag").isVisible(),
    false,
    "the selection tag hides behind the text toolbar",
  );
  await page.keyboard.press("Control+a");
  await page.keyboard.type("After");
  const textBounds = await target.boundingBox();
  await page.mouse.move(textBounds.x + 1, textBounds.y + textBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(textBounds.x + textBounds.width - 1, textBounds.y + textBounds.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  NodeAssert.equal(await page.evaluate(() => window.getSelection().toString()), "After");
  NodeAssert.ok(Math.abs((await target.boundingBox()).x - textBounds.x) < 1);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  NodeAssert.equal(await target.textContent(), "After");
  const saved = await page.evaluate(() => window.designSaves.at(-1).html);
  NodeAssert.ok(saved.includes("After"));
  NodeAssert.ok(
    !saved.includes("--t3-canvas-") &&
      !saved.includes("data-t3code-design-ui") &&
      !saved.includes("contenteditable"),
  );
  await page.getByRole("button", { name: "Diamond (D)", exact: true }).click();
  await page.mouse.move(600, 600);
  await page.mouse.down();
  await page.mouse.move(720, 680, { steps: 8 });
  await page.mouse.up();
  NodeAssert.equal(await page.locator('[data-t3-design-object="diamond"] polygon').count(), 1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close properties", exact: true }).click();
  NodeAssert.equal(await properties.isVisible(), false);
  for (const width of [1440, 900, 875, 801, 600, 400]) {
    await page.setViewportSize({ width, height: 900 });
    const tools = await page.getByRole("toolbar", { name: "Drawing tools" }).boundingBox();
    const actions = await page.getByRole("button", { name: "Save", exact: true }).boundingBox();
    for (const name of ["Edit", "Add to chat"]) {
      const button = page.getByRole("button", { name, exact: true });
      const bounds = await button.boundingBox();
      NodeAssert.equal(bounds.height, actions.height);
      NodeAssert.equal(bounds.y, actions.y);
      NodeAssert.equal(await button.evaluate((e) => getComputedStyle(e).fontSize), "11px");
    }
    NodeAssert.ok(tools.x >= 0 && tools.x + tools.width <= width);
    NodeAssert.equal(tools.y, actions.y, `toolbar aligns with actions at ${width}`);
    NodeAssert.equal(tools.height, actions.height, `toolbar matches action height at ${width}`);
    const menuBounds = await menu.boundingBox();
    NodeAssert.equal(menuBounds.y, actions.y);
    NodeAssert.equal(menuBounds.height, actions.height);
    const leftGap = tools.x - menuBounds.x - menuBounds.width;
    const rightGap = (await editToggle.boundingBox()).x - tools.x - tools.width;
    NodeAssert.ok(Math.abs(leftGap - rightGap) < 1, `equal tool-strip gaps at ${width}`);
    if (width > 600) {
      const hint = await page
        .getByText("Hold Space to pan · Pinch to zoom · Double-click text to edit", { exact: true })
        .boundingBox();
      NodeAssert.ok(Math.abs(hint.x + hint.width / 2 - tools.x - tools.width / 2) < 1);
      NodeAssert.equal(hint.y - tools.y - tools.height, 12);
    }
    NodeAssert.ok(
      tools.y >= actions.y + actions.height || tools.x + tools.width <= actions.x,
      `toolbar does not overlap actions at ${width}`,
    );
    await editToggle.click();
    const panel = await properties.boundingBox();
    NodeAssert.ok(panel.x >= 0 && panel.x + panel.width <= width);
    NodeAssert.ok((await page.locator(".layer").count()) > 0, `layers render at ${width}`);
    NodeAssert.equal(
      await page.getByText("Select an element to edit it", { exact: true }).isVisible(),
      true,
    );
    await page.getByRole("button", { name: "Close properties", exact: true }).click();
    await page.getByRole("button", { name: "Help", exact: true }).click();
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
    const closeHelp = help.getByRole("button", { name: "Close keyboard shortcuts", exact: true });
    const helpBounds = await help.boundingBox();
    const closeBounds = await closeHelp.boundingBox();
    NodeAssert.ok(closeBounds.y - helpBounds.y < 16);
    NodeAssert.ok(helpBounds.x + helpBounds.width - closeBounds.x - closeBounds.width < 16);
    NodeAssert.ok(await help.evaluate((e) => e.scrollWidth <= e.clientWidth));
    await closeHelp.click();
    NodeAssert.equal(await help.isVisible(), false);
  }
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page.keyboard.press("Escape");
  NodeAssert.equal(
    await page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true }).isVisible(),
    false,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.unroute("**/*");
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><style>
    body{margin:0;width:1440px;height:900px;font:16px system-ui}
    .card{position:absolute;top:300px;left:400px;width:180px;height:120px;background:white;box-sizing:border-box}
    #first{color:rgb(190, 20, 50)}#second{left:650px;top:340px}#third{left:900px}
    </style><div class="card" id="first">First</div><div class="card" id="second">Second</div><div class="card" id="third"><label for="email">Email</label><input id="email" value="hello"></div>`,
    }),
  );
  await page.reload();
  await page.evaluate(installEditor, source);
  const focus = page.locator("[data-t3-design-focus]");
  const clickElement = async (selector, modifier) => {
    const box = await page.locator(selector).boundingBox();
    if (modifier) await page.keyboard.down(modifier);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 12);
    if (modifier) await page.keyboard.up(modifier);
  };
  for (const [keys, label] of [
    [["v", "1"], "Select (V)"],
    [["r", "b", "2"], "Rectangle (R)"],
    [["d", "3"], "Diamond (D)"],
    [["o", "c", "4"], "Ellipse (O)"],
    [["a", "5"], "Arrow (A)"],
    [["l", "6"], "Line (L)"],
    [["p", "7"], "Draw (P)"],
    [["h"], "Hand (H)"],
    [["Shift+h"], "Highlight (Shift+H)"],
  ])
    for (const key of keys) {
      await page.keyboard.press(key);
      NodeAssert.equal(
        await page.getByRole("button", { name: label, exact: true }).getAttribute("aria-pressed"),
        "true",
        key,
      );
    }
  await page.keyboard.press("v");
  await page.mouse.click(1300, 850);
  NodeAssert.ok(
    await page.evaluate(
      () =>
        document.activeElement === document.body || document.body.contains(document.activeElement),
    ),
    "a canvas click keeps focus inside the editor document",
  );
  await clickElement("#first");
  for (const modifier of ["Control", "Meta"]) {
    await page.keyboard.press(`${modifier}+d`);
    NodeAssert.equal(await page.locator(".card").count(), 4);
    NodeAssert.notEqual(await focus.getAttribute("id"), "first");
    NodeAssert.equal(
      await focus.evaluate((element) => getComputedStyle(element).color),
      "rgb(190, 20, 50)",
    );
    await page.keyboard.press(`${modifier}+z`);
    NodeAssert.equal(await page.locator(".card").count(), 3);
    await page.keyboard.press(`${modifier}+Shift+z`);
    NodeAssert.equal(await page.locator(".card").count(), 4);
    await page.keyboard.press("Backspace");
    NodeAssert.equal(await page.locator(".card").count(), 3);
    await clickElement("#first");
  }
  await clickElement("#second", "Shift");
  NodeAssert.equal(await focus.count(), 2);
  await page.keyboard.press("Control+g");
  const groupId = await page.locator("#first").getAttribute("data-t3-design-groups");
  NodeAssert.ok(groupId);
  NodeAssert.equal(await page.locator("#second").getAttribute("data-t3-design-groups"), groupId);
  await page.keyboard.press("Escape");
  await clickElement("#first");
  NodeAssert.equal(await focus.count(), 2, "click selects the group");
  await clickElement("#first", "Control");
  NodeAssert.equal(await focus.count(), 1, "modifier click selects inside a group");
  await page.keyboard.press("Escape");
  await clickElement("#first");
  const positions = await focus.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().x),
  );
  const zoom = await page.evaluate(() =>
    Number(document.documentElement.style.getPropertyValue("--t3-canvas-zoom")),
  );
  for (const key of ["ArrowRight", "Shift+ArrowDown", "ArrowLeft", "Shift+ArrowUp"])
    await page.keyboard.press(key);
  NodeAssert.deepEqual(
    await focus.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().x),
    ),
    positions,
  );
  await page.keyboard.press("Shift+ArrowRight");
  const nudged = await focus.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().x),
  );
  nudged.forEach((x, i) => NodeAssert.ok(Math.abs(x - positions[i] - 10 * zoom) < 0.1));
  await page.keyboard.press("Control+z");
  NodeAssert.deepEqual(
    await focus.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().x),
    ),
    positions,
  );
  await page.keyboard.press("Control+d");
  NodeAssert.equal(await focus.count(), 2);
  NodeAssert.equal(await page.locator(".card").count(), 5);
  const cloneGroups = await focus.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-t3-design-groups")),
  );
  NodeAssert.equal(cloneGroups[0], cloneGroups[1]);
  NodeAssert.notEqual(cloneGroups[0], groupId);
  await page.keyboard.press("Control+z");
  NodeAssert.equal(await page.locator(".card").count(), 3, "one undo removes all duplicates");
  for (const [key, axis, factor] of [
    ["a", "x", 0],
    ["h", "x", 0.5],
    ["d", "x", 1],
    ["w", "y", 0],
    ["v", "y", 0.5],
    ["s", "y", 1],
  ]) {
    await page.keyboard.press(`Alt+${key}`);
    const aligned = await focus.evaluateAll(
      (elements, { axis, factor }) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return rect[axis] + rect[axis === "x" ? "width" : "height"] * factor;
        }),
      { axis, factor },
    );
    NodeAssert.ok(Math.abs(aligned[0] - aligned[1]) < 0.1, `Alt+${key} aligns the selection`);
    await page.keyboard.press("Control+z");
  }
  const dragStart = await page.locator("#first").boundingBox();
  for (const key of ["Escape", "Control+z", "Control+s"]) {
    await page.mouse.move(dragStart.x + 40, dragStart.y + 80);
    await page.mouse.down();
    await page.mouse.move(dragStart.x + 70, dragStart.y + 100, { steps: 4 });
    await page.keyboard.press(key);
    await page.mouse.up();
    NodeAssert.deepEqual(
      await focus.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().x),
      ),
      positions,
      `${key} cancels a pending drag`,
    );
    NodeAssert.equal(
      await page.locator("[data-t3-design-groups]").count(),
      2,
      `${key} keeps the previous edit`,
    );
  }
  await page.mouse.move(dragStart.x + 40, dragStart.y + 80);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 70, dragStart.y + 100, { steps: 4 });
  await page.mouse.up();
  const dragged = await focus.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().x),
  );
  dragged.forEach((x, i) => NodeAssert.ok(Math.abs(x - positions[i] - 30) < 0.1));
  await page.keyboard.press("Control+z");
  const sizes = await focus.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().width),
  );
  const resizeHandle = await page.getByLabel("Resize se", { exact: true }).boundingBox();
  await page.mouse.move(
    resizeHandle.x + resizeHandle.width / 2,
    resizeHandle.y + resizeHandle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(resizeHandle.x + 60, resizeHandle.y + 40, { steps: 4 });
  await page.mouse.up();
  (
    await focus.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().width),
    )
  ).forEach((width, i) => NodeAssert.ok(width > sizes[i]));
  await page.keyboard.press("Control+z");
  NodeAssert.deepEqual(
    await focus.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().width),
    ),
    sizes,
  );
  await editToggle.click();
  await page.getByText("Sizing", { exact: true }).click();
  const groupWidth = page.getByRole("spinbutton", { name: "Width", exact: true }).first();
  const oldGroupWidth = Number(await groupWidth.inputValue());
  await groupWidth.fill(String(oldGroupWidth * 1.25));
  await page.getByRole("button", { name: "Select (V)", exact: true }).click();
  const fieldSizes = await focus.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().width),
  );
  fieldSizes.forEach((width, i) => NodeAssert.ok(Math.abs(width - sizes[i] * 1.25) < 1));
  await page.keyboard.press("Control+z");
  NodeAssert.deepEqual(
    await focus.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().width),
    ),
    sizes,
  );
  await page.keyboard.down("Alt");
  await page.mouse.move(dragStart.x + 40, dragStart.y + 80);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 70, dragStart.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  NodeAssert.equal(await page.locator(".card").count(), 5);
  await page.keyboard.press("Control+z");
  NodeAssert.equal(
    await page.locator(".card").count(),
    3,
    "one undo removes an Alt-drag duplicate",
  );
  await page.keyboard.down("Alt");
  await page.mouse.move(dragStart.x + 40, dragStart.y + 80);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 70, dragStart.y + 100, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.keyboard.up("Alt");
  NodeAssert.equal(
    await page.locator(".card").count(),
    3,
    "Escape removes an unfinished Alt-drag duplicate",
  );
  await page.keyboard.press("Control+Shift+z");
  NodeAssert.equal(await page.locator(".card").count(), 5, "cancelled drag preserves redo history");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+Shift+h");
  NodeAssert.equal(
    await page.locator("#first").evaluate((element) => getComputedStyle(element).visibility),
    "hidden",
  );
  await page.keyboard.press("Control+Shift+h");
  NodeAssert.equal(
    await page.locator("#first").evaluate((element) => getComputedStyle(element).visibility),
    "visible",
  );
  await page.keyboard.press("Escape");
  const firstBounds = await page.locator("#first").boundingBox();
  const secondBounds = await page.locator("#second").boundingBox();
  await page.mouse.move(firstBounds.x - 20, firstBounds.y - 20);
  await page.mouse.down();
  await page.mouse.move(
    secondBounds.x + secondBounds.width + 20,
    secondBounds.y + secondBounds.height + 20,
    { steps: 4 },
  );
  await page.mouse.up();
  NodeAssert.equal(await focus.count(), 2, "marquee selects both elements");
  await page.getByRole("button", { name: "Add to chat", exact: true }).click();
  await page.waitForFunction(() =>
    window.designSaves.some((change) => change.annotation?.elements.length === 2),
  );
  await page.keyboard.press("Meta+Shift+g");
  NodeAssert.equal(await page.locator("[data-t3-design-groups]").count(), 0);
  await page.keyboard.press("Meta+z");
  NodeAssert.equal(await page.locator("[data-t3-design-groups]").count(), 2);
  await page.keyboard.press("Control+Shift+l");
  await page.keyboard.press("Delete");
  NodeAssert.equal(await page.locator(".card").count(), 3, "locked elements cannot be deleted");
  await page.locator(".layer").first().click();
  await page.keyboard.press("Control+Shift+l");
  NodeAssert.equal(await page.locator("[data-t3-design-locked]").count(), 0);
  await page.keyboard.press("Control+Shift+BracketRight");
  NodeAssert.deepEqual(
    await page.locator("body > .card").evaluateAll((elements) => elements.map((e) => e.id)),
    ["third", "first", "second"],
  );
  await page.keyboard.press("Control+z");
  NodeAssert.deepEqual(
    await page.locator("body > .card").evaluateAll((elements) => elements.map((e) => e.id)),
    ["first", "second", "third"],
  );
  await page.keyboard.press("Control+Shift+g");
  await page.keyboard.press("Escape");
  await clickElement("#first");
  await page.keyboard.press("Enter");
  NodeAssert.equal(await page.locator("#first").getAttribute("contenteditable"), "true");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Typed vrdhop");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+b");
  NodeAssert.match(await page.locator("#first").innerHTML(), /<b>|font-weight/);
  await page.keyboard.press("Control+i");
  NodeAssert.match(await page.locator("#first").innerHTML(), /<i>|font-style/);
  await page.keyboard.press("Control+u");
  NodeAssert.match(await page.locator("#first").innerHTML(), /<u>|text-decoration/);
  await page.keyboard.press("Meta+Enter");
  NodeAssert.equal(await page.locator("#first").getAttribute("contenteditable"), null);
  NodeAssert.equal(await page.locator(".card").count(), 3, "typing does not trigger tools");
  await page.keyboard.press("Control+z");
  NodeAssert.equal(await page.locator("#first").textContent(), "First");
  await page.keyboard.press("Control+y");
  NodeAssert.equal(await page.locator("#first").textContent(), "Typed vrdhop");
  await page.keyboard.press("Enter");
  NodeAssert.equal(
    await page.locator("#first").getAttribute("contenteditable"),
    "true",
    "formatted text can reopen",
  );
  await page.keyboard.press("Escape");
  await clickElement("#third");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.keyboard.press("Control+c");
  NodeAssert.match(await page.evaluate(() => navigator.clipboard.readText()), /id="third"/);
  await page.keyboard.press("Control+v");
  NodeAssert.equal(await page.locator(".card").count(), 4);
  NodeAssert.equal(
    await focus.locator("label").getAttribute("for"),
    await focus.locator("input").getAttribute("id"),
  );
  NodeAssert.notEqual(await focus.locator("input").getAttribute("id"), "email");
  await page.keyboard.press("Control+x");
  NodeAssert.equal(await page.locator(".card").count(), 3);
  await page.keyboard.press("Control+v");
  NodeAssert.equal(await page.locator(".card").count(), 4);
  await page.evaluate(() => navigator.clipboard.writeText("<script>plain text</script>"));
  await page.keyboard.press("Control+v");
  NodeAssert.equal(await focus.textContent(), "<script>plain text</script>");
  NodeAssert.equal(await focus.locator("script").count(), 0);
  for (const key of ["t", "8", "n"]) {
    await page.keyboard.press(key);
    NodeAssert.equal(
      await focus.getAttribute("data-t3-design-object"),
      key === "n" ? "note" : "text",
    );
    await page.keyboard.press("Delete");
  }
  await page.keyboard.press("Escape");
  await clickElement("#first");
  await page.keyboard.press("Tab");
  NodeAssert.equal(await focus.getAttribute("id"), "second");
  await page.keyboard.press("Shift+Tab");
  NodeAssert.equal(await focus.getAttribute("id"), "first");
  await page.keyboard.press("Control+a");
  for (const [key, axis, size] of [
    ["h", "x", "width"],
    ["v", "y", "height"],
  ]) {
    await page.keyboard.press(`Control+Alt+${key}`);
    const gaps = await focus.evaluateAll(
      (elements, { axis, size }) => {
        const rects = elements
          .map((e) => e.getBoundingClientRect())
          .sort((a, b) => a[axis] - b[axis]);
        return rects.slice(1).map((rect, i) => rect[axis] - rects[i][axis] - rects[i][size]);
      },
      { axis, size },
    );
    NodeAssert.ok(
      Math.max(...gaps) - Math.min(...gaps) < 0.2,
      `Control+Alt+${key} creates equal gaps`,
    );
    await page.keyboard.press("Control+z");
  }
  await page.keyboard.press("Escape");
  await clickElement("#first");
  await client.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "c",
    code: "KeyC",
    modifiers: 4,
    windowsVirtualKeyCode: 67,
    commands: ["copy"],
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "c",
    code: "KeyC",
    modifiers: 4,
    windowsVirtualKeyCode: 67,
  });
  const beforeMacPaste = await page.locator(".card").count();
  await client.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "v",
    code: "KeyV",
    modifiers: 4,
    windowsVirtualKeyCode: 86,
    commands: ["paste"],
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "v",
    code: "KeyV",
    modifiers: 4,
    windowsVirtualKeyCode: 86,
  });
  NodeAssert.equal(
    await page.locator(".card").count(),
    beforeMacPaste + 1,
    "Mac clipboard commands use the same element clipboard",
  );
  await page.keyboard.press("Meta+z");
  await page.keyboard.press("Control+0");
  NodeAssert.equal(await page.getByLabel("Zoom options", { exact: true }).textContent(), "100%");
  await page.keyboard.press("Meta+Equal");
  NodeAssert.equal(await page.getByLabel("Zoom options", { exact: true }).textContent(), "120%");
  await page.keyboard.press("Control+Minus");
  NodeAssert.equal(await page.getByLabel("Zoom options", { exact: true }).textContent(), "100%");
  await page.keyboard.press("Shift+1");
  await page.keyboard.press("Control+a");
  NodeAssert.ok((await focus.count()) >= 4);
  await page.keyboard.press("Shift+2");
  const selectedIds = await focus.evaluateAll((elements) => elements.map((element) => element.id));
  await page.keyboard.press("Control+g");
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => window.designSaves.length > 0);
  const keyboardSaved = await page.evaluate(() => window.designSaves.at(-1).html);
  for (const id of selectedIds.filter(Boolean)) NodeAssert.ok(keyboardSaved.includes(`id="${id}"`));
  NodeAssert.ok(!keyboardSaved.includes("data-t3-design-focus"));
  await page.keyboard.press("Escape");
  NodeAssert.equal(await focus.count(), 0);
  await page.keyboard.press("?");
  await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
  await page.keyboard.press("Escape");
  NodeAssert.equal(
    await page.getByRole("dialog", { name: "Keyboard shortcuts" }).isVisible(),
    false,
  );
  NodeAssert.ok(keyboardSaved.includes("data-t3-design-groups"));
  await page.unroute("**/*");
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: keyboardSaved }),
  );
  await page.reload();
  await page.evaluate(installEditor, source);
  NodeAssert.equal(await focus.count(), 0, "reload starts with no selected elements");
  await page.keyboard.press("v");
  await clickElement("#first");
  NodeAssert.ok((await focus.count()) >= 4, "saved groups work after reload");
  console.log(
    "PASS keyboard: tools, duplicate, multi-select, groups, nudge, align, layers, lock, rich text, clipboard, undo/redo, save, zoom, and help",
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("r");
  const boxCount = await page.locator('[data-t3-design-object="box"]').count();
  await page.evaluate(() => {
    const send = (type, pointerId, clientX, clientY) =>
      window.dispatchEvent(
        new PointerEvent(type, { pointerId, pointerType: "touch", button: 0, clientX, clientY }),
      );
    send("pointerdown", 101, 450, 450);
    send("pointermove", 101, 550, 550);
    send("pointerdown", 102, 600, 450);
    send("pointermove", 102, 650, 550);
    send("pointerup", 102, 650, 550);
    send("pointercancel", 102, 650, 550);
  });
  NodeAssert.equal(
    await page.locator('[data-t3-design-object="box"]').count(),
    boxCount + 1,
    "another touch cannot start an orphan shape",
  );
  NodeAssert.equal(
    await page
      .getByRole("button", { name: "Rectangle (R)", exact: true })
      .getAttribute("aria-pressed"),
    "true",
    "another touch cannot finish the active shape",
  );
  await page.evaluate(() =>
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        pointerId: 101,
        pointerType: "touch",
        button: 0,
        clientX: 550,
        clientY: 550,
      }),
    ),
  );
  NodeAssert.equal(
    await page
      .getByRole("button", { name: "Select (V)", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.keyboard.press("Control+z");
  NodeAssert.equal(
    await page.locator('[data-t3-design-object="box"]').count(),
    boxCount,
    "one undo removes the completed shape",
  );
  await page.locator(".zoom-menu > summary").click();
  await page.getByRole("button", { name: "25%", exact: true }).click();
  await page.keyboard.press("r");
  await page.mouse.move(450, 450);
  await page.mouse.down();
  await page.mouse.move(453, 453);
  await page.mouse.up();
  NodeAssert.equal(
    await page.locator('[data-t3-design-object="box"]').count(),
    boxCount + 1,
    "canvas-sized shapes survive at 25% zoom",
  );
  const tinyBox = page.locator('[data-t3-design-object="box"]').last();
  await tinyBox.evaluate((e) => {
    e.style.width = "0px";
    e.style.height = "0px";
    e.style.border = "none";
  });
  const handle = await page.getByRole("button", { name: "Resize se", exact: true }).boundingBox();
  await page.mouse.move(handle.x + 4, handle.y + 4);
  await page.mouse.down();
  await page.mouse.move(handle.x + 24, handle.y + 24);
  await page.mouse.up();
  NodeAssert.ok(
    !(await tinyBox.evaluate((e) => e.outerHTML)).includes("NaN"),
    "zero-sized elements cannot gain invalid coordinates",
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("a");
  await page.mouse.move(450, 450);
  await page.mouse.down();
  await page.mouse.move(520, 520);
  await page.mouse.up();
  if ((await page.locator(".top-actions .edit").getAttribute("aria-pressed")) !== "true")
    await page.locator(".top-actions .edit").click();
  await page.locator(".inspector summary").getByText("Drawing", { exact: true }).click();
  await page.getByLabel("Stroke", { exact: true }).fill("#e03131");
  await page.getByLabel("Stroke", { exact: true }).press("Tab");
  const arrowColors = await page
    .locator('[data-t3-design-object="arrow"]')
    .last()
    .evaluate((e) => [
      getComputedStyle(e.querySelector("line")).stroke,
      getComputedStyle(e.querySelector("polygon")).fill,
    ]);
  NodeAssert.equal(
    arrowColors[0],
    arrowColors[1],
    "arrowheads use the same stroke color as the shaft",
  );
  const editorBundle = `${temporary}/editor.js`;
  NodeChildProcess.execFileSync(
    `${repo}node_modules/.bin/esbuild`,
    [
      "packages/client-runtime/src/design/editor.ts",
      "--bundle",
      "--platform=browser",
      "--format=iife",
      "--global-name=DesignEditor",
      `--outfile=${editorBundle}`,
    ],
    { cwd: repo },
  );
  const embedded = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  await embedded.emulateMedia({ reducedMotion: "reduce" });
  embedded.on("pageerror", (error) => errors.push(error.message));
  await embedded.setContent(
    '<iframe title="Design" sandbox="allow-same-origin" style="width:1000px;height:780px;border:0"></iframe>',
  );
  await embedded.addScriptTag({ content: NodeFS.readFileSync(editorBundle, "utf8") });
  await embedded.evaluate(async () => {
    const frame = document.querySelector("iframe");
    const loaded = new Promise((resolve) =>
      frame.addEventListener("load", resolve, { once: true }),
    );
    frame.srcdoc =
      '<style>body{margin:40px;font:20px system-ui;background:#f8f9fb}main{width:700px;height:400px;background:white;padding:40px}</style><main data-t3-design-artboard="Account"><h1 data-t3-design-focus="true">Account</h1></main><script>parent.unsafeDesignScript=true</script>';
    await loaded;
    const attach = frame.contentWindow.Element.prototype.attachShadow;
    frame.contentWindow.Element.prototype.attachShadow = function (options) {
      return attach.call(this, { ...options, mode: "open" });
    };
    window.embeddedChanges = [];
    window.rejectDesignSave = false;
    window.canvasTheme = {
      colorScheme: "dark",
      radius: "0.625rem",
      background: "rgb(20, 20, 24)",
      foreground: "#eeeeee",
      popover: "#202024",
      popoverForeground: "#eeeeee",
      primary: "#93aaff",
      primaryForeground: "#101014",
      muted: "#28282c",
      mutedForeground: "#aaaaaa",
      accent: "#303034",
      accentForeground: "#eeeeee",
      border: "#444448",
      input: "#444448",
      ring: "#93aaff",
      fontSans: "system-ui",
      fontMono: "monospace",
    };
    const editor = DesignEditor.startDesignEditor(frame.contentWindow, {
      url: "http://localhost/api/assets/test?t3-design=1&t3-design-path=.t3/designs/test.html",
      theme: window.canvasTheme,
      onChange: async (change) => {
        if (window.rejectDesignSave) throw new Error("Save failed");
        window.embeddedChanges.push(change);
      },
    });
    editor.setOpen(true);
    window.designEditor = editor;
  });
  const frame = embedded.frameLocator('iframe[title="Design"]');
  NodeAssert.notEqual(
    await frame.locator("html").evaluate((e) => getComputedStyle(e).backgroundColor),
    "rgb(20, 20, 24)",
  );
  for (const [colorScheme, background] of [
    ["dark", "rgb(20, 20, 24)"],
    ["light", "rgb(246, 247, 249)"],
    ["dark", "rgb(16, 24, 40)"],
  ]) {
    await embedded.evaluate(
      ({ colorScheme, background }) => {
        window.designEditor.setTheme({
          ...window.canvasTheme,
          colorScheme,
          background,
          foreground: colorScheme === "dark" ? "#eeeeee" : "#222222",
          mutedForeground: colorScheme === "dark" ? "#aaaaaa" : "#666666",
        });
      },
      { colorScheme, background },
    );
    const canvasColor = await frame
      .locator("html")
      .evaluate((e) => getComputedStyle(e).backgroundColor);
    const canvasChannels = canvasColor.match(/[\d.]+/g).map(Number);
    const appChannels = background.match(/[\d.]+/g).map((value) => Number(value) / 255);
    for (let channel = 0; channel < 3; channel++) {
      const lift =
        (canvasChannels[channel] - appChannels[channel]) * (colorScheme === "dark" ? 1 : -1);
      NodeAssert.ok(
        colorScheme === "dark" ? lift > 0.02 && lift < 0.05 : lift > 0.04 && lift < 0.1,
        `${colorScheme} canvas has a soft contrast with the app`,
      );
    }
    NodeAssert.equal(
      await frame.locator("body").evaluate((e) => getComputedStyle(e).backgroundColor),
      "rgba(0, 0, 0, 0)",
    );
    NodeAssert.equal(
      await frame.locator("main").evaluate((e) => getComputedStyle(e).backgroundColor),
      "rgb(255, 255, 255)",
    );
    NodeAssert.equal(
      await frame
        .getByRole("toolbar", { name: "Drawing tools" })
        .evaluate((e) => getComputedStyle(e).backgroundColor),
      background,
    );
    for (const control of [
      frame.getByRole("button", { name: "Zoom in", exact: true }).locator(".."),
      frame.getByRole("button", { name: "Undo", exact: true }).locator(".."),
      frame.getByRole("button", { name: "Help", exact: true }),
    ]) {
      NodeAssert.equal(
        await control.evaluate((e) => getComputedStyle(e).backgroundColor),
        background,
      );
    }
    NodeAssert.equal(
      await frame
        .getByRole("button", { name: "Save", exact: true })
        .evaluate((e) => getComputedStyle(e).color),
      colorScheme === "dark" ? "rgb(238, 238, 238)" : "rgb(34, 34, 34)",
    );
  }
  await embedded.evaluate(() => window.designEditor.setOpen(false));
  NodeAssert.equal(
    await frame.locator("body").evaluate((e) => getComputedStyle(e).backgroundColor),
    "rgb(248, 249, 251)",
  );
  await embedded.evaluate(() => window.designEditor.setOpen(true));
  NodeAssert.equal(await embedded.evaluate(() => window.unsafeDesignScript), undefined);
  NodeAssert.equal(await frame.locator("[data-t3-design-focus]").count(), 0);
  await frame.getByRole("button", { name: "Select (V)", exact: true }).click();
  const heading = frame.locator("h1");
  await heading.click();
  NodeAssert.equal(await frame.locator("[data-t3-design-focus]").count(), 1);
  NodeAssert.ok(
    await embedded.evaluate(() => document.querySelector("iframe").contentDocument.hasFocus()),
    "a canvas click focuses the editor frame",
  );
  await embedded.keyboard.press("Escape");
  NodeAssert.equal(
    await frame.locator("[data-t3-design-focus]").count(),
    0,
    "a canvas click focuses the editor frame so shortcuts reach it",
  );
  await heading.click();
  await frame.getByRole("button", { name: "Edit", exact: true }).click();
  const originalColor = await heading.evaluate((e) => e.style.color);
  await frame.getByRole("button", { name: "Text color #e03131", exact: true }).click();
  NodeAssert.notEqual(await heading.evaluate((e) => e.style.color), originalColor);
  await frame.getByRole("button", { name: "Undo", exact: true }).click();
  NodeAssert.equal(
    await heading.evaluate((e) => e.style.color),
    originalColor,
    "swatch changes can be undone",
  );
  const weight = frame.getByLabel("Weight", { exact: true });
  await weight.focus();
  await weight.selectOption("700");
  await weight.selectOption("900");
  NodeAssert.equal(await heading.evaluate((e) => getComputedStyle(e).fontWeight), "900");
  await frame.getByRole("button", { name: "Undo", exact: true }).click();
  NodeAssert.equal(await heading.evaluate((e) => getComputedStyle(e).fontWeight), "700");
  const text = frame.getByLabel("Text", { exact: true });
  await text.fill("Edited in the app");
  await text.press("Tab");
  await embedded.waitForFunction(() =>
    window.embeddedChanges.some((change) => change.html.includes("Edited in the app")),
  );
  const savedDesign = await embedded.evaluate(() => window.embeddedChanges.at(-1).html);
  NodeAssert.ok(savedDesign.includes("background:#f8f9fb"));
  NodeAssert.ok(!savedDesign.includes("--t3-canvas-background"));
  NodeAssert.ok(
    await embedded.evaluate(() => window.embeddedChanges.every((change) => !change.annotation)),
  );
  await frame.getByRole("button", { name: "Add to chat", exact: true }).click();
  await embedded.waitForFunction(() =>
    window.embeddedChanges
      .at(-1)
      .annotation?.elements[0].element.htmlPreview.includes("Edited in the app"),
  );
  await embedded.evaluate(() => {
    window.rejectDesignSave = true;
  });
  await frame.getByRole("button", { name: "Save", exact: true }).click();
  await frame.getByText("Save failed · retry Save", { exact: true }).waitFor();
  NodeAssert.equal(await heading.textContent(), "Edited in the app");
  console.log(
    "PASS embedded editor: isolated scripts, auto-save, distinct attachment, repeated property edits, undo, and failed-save feedback",
  );
  NodeAssert.deepEqual(errors, []);
  console.log(
    "PASS canvas: pan, zoom, first drag, undo/redo, text, save, shapes, and four viewport widths",
  );
} finally {
  await browser.close();
  NodeFS.rmSync(temporary, { recursive: true });
}
