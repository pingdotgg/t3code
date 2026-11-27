import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { JSDOM } from "jsdom";
import { build } from "vite-plus/pack";
import { assert, it } from "vite-plus/test";

import desktopConfig from "../vite.config.ts";

it("gives the page's world a function that runs without the preload's scope", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-preview-preload-"));
  try {
    assert.ok(Array.isArray(desktopConfig.pack));
    const packConfig = desktopConfig.pack.find(
      (config) =>
        Array.isArray(config.entry) && config.entry.includes("src/preview-pick-preload.ts"),
    );
    assert.ok(packConfig);
    await build({
      ...packConfig,
      config: false,
      cwd: NodePath.join(import.meta.dirname, ".."),
      outDir: directory,
      sourcemap: false,
      logLevel: "silent",
    });
    const source = await NodeFSP.readFile(
      NodePath.join(directory, "preview-pick-preload.cjs"),
      "utf8",
    );

    const executions = [];
    const electron = {
      contextBridge: {
        executeInMainWorld: (execution) => {
          executions.push(execution);
          return { elementContext: async () => null };
        },
      },
      ipcRenderer: { on: () => {}, off: () => {}, send: () => {}, sendToHost: () => {} },
    };
    const preload = new JSDOM("<!doctype html>", { runScripts: "outside-only" });
    NodeVM.runInContext(
      source,
      Object.assign(preload.getInternalVMContext(), {
        process: { argv: [] },
        require: (specifier) => {
          assert.equal(specifier, "electron");
          return electron;
        },
      }),
    );
    assert.equal(executions.length, 1);

    // Electron compiles the function's source text in the page, where nothing of the preload exists.
    const page = new JSDOM('<!doctype html><button id="target">Pay</button>', {
      runScripts: "outside-only",
      // React Grab binds requestAnimationFrame while it loads.
      pretendToBeVisual: true,
    });
    const install = NodeVM.runInContext(`(${executions[0].func})`, page.getInternalVMContext());
    const context = await install(...executions[0].args).elementContext(
      page.window.document.getElementById("target"),
    );
    assert.equal(context.selector, "#target");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
