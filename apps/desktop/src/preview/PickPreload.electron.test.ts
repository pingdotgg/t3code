// @effect-diagnostics nodeBuiltinImport:off -- The Playwright fixture bundles and launches a temporary Electron app.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { _electron } from "playwright-core";
import { Rolldown } from "vite-plus/pack";
import { expect, it } from "vite-plus/test";

import { START_PICK_CHANNEL } from "./GuestProtocol.ts";

it("preserves a diagonal on a blank click and erases it on a near-stroke click", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-stroke-"));
  try {
    const preload = NodePath.join(directory, "preload.cjs");
    const bundle = await Rolldown.rolldown({
      input: NodeURL.fileURLToPath(new URL("./PickPreload.ts", import.meta.url)),
      external: ["electron"],
      plugins: [
        {
          name: "stub-page-inspection",
          resolveId(source) {
            if (source === "./PageWorldBridge.ts") return "\0page-inspection";
          },
          load(id) {
            if (id === "\0page-inspection") return "export const pageWorld = {};";
          },
        },
      ],
    });
    try {
      await bundle.write({ file: preload, format: "cjs" });
    } finally {
      await bundle.close();
    }

    const main = NodePath.join(directory, "main.cjs");
    await NodeFSP.writeFile(
      main,
      `const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const window = new BrowserWindow({
    show: false, width: 800, height: 600, webPreferences: { preload: ${JSON.stringify(preload)} },
  });
  void window.loadURL("data:text/html,<!doctype html><title>Annotation test</title><main>Test page</main>");
});`,
    );
    const app = await _electron.launch({
      args: [
        ...(HostProcess.Platform.defaultValue() === "linux" ? ["--ozone-platform=headless"] : []),
        main,
      ],
    });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState();
      // An undisplayed Electron window can start with a 1×1 renderer viewport.
      await page.setViewportSize({ width: 800, height: 600 });
      await app.evaluate(({ BrowserWindow }, channel) => {
        BrowserWindow.getAllWindows()[0]!.webContents.send(channel, undefined, false);
      }, START_PICK_CHANNEL);
      await page
        .locator('html[data-t3code-annotation-tool="select"]')
        .waitFor({ state: "attached", timeout: 3_000 });

      // The accessibility tree exposes the toolbar and editor inside the closed shadow root.
      const cdp = await page.context().newCDPSession(page);
      const canAttach = async () => {
        const { nodes } = await cdp.send("Accessibility.getFullAXTree");
        return nodes.some(
          (node) =>
            !node.ignored &&
            node.role?.value === "button" &&
            node.name?.value === "Attach" &&
            !node.properties?.some(({ name, value }) => name === "disabled" && value.value),
        );
      };

      await page.keyboard.press("d");
      await page.mouse.move(100, 220);
      await page.mouse.down();
      await page.mouse.move(240, 360, { steps: 4 });
      await page.mouse.up();
      expect(await canAttach()).toBe(true);

      const { nodes } = await cdp.send("Accessibility.getFullAXTree");
      const erase = nodes.find(
        (node) => !node.ignored && node.role?.value === "button" && node.name?.value === "Erase",
      );
      const backendNodeId = erase?.backendDOMNodeId;
      if (backendNodeId === undefined) throw new Error("Erase toolbar button not found");
      const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId });
      const [left, top, , , right, bottom] = model.border;
      await page.mouse.click((left! + right!) / 2, (top! + bottom!) / 2);
      expect(await page.locator("html").getAttribute("data-t3code-annotation-tool")).toBe("erase");
      await page.mouse.click(120, 340);
      expect(await canAttach()).toBe(true);

      await page.mouse.click(170, 295);
      expect(await canAttach()).toBe(false);
    } finally {
      await app.close();
    }
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
