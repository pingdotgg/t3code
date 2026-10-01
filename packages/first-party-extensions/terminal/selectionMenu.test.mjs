/**
 * The selection menu's DOM controller over the REAL selectionMenu.tsx,
 * bundled by esbuild into the system tmpdir with fake timers and listener
 * targets standing in for the DOM.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(new URL(".", import.meta.url));
const { build } = require("esbuild");
const packageDir = NodeURL.fileURLToPath(new URL(".", import.meta.url));

let Controller;
NodeTest.before(async () => {
  const built = await build({
    stdin: {
      contents:
        NodeFS.readFileSync(NodePath.join(packageDir, "selectionMenu.tsx"), "utf8") +
        "\nexport { TerminalSelectionMenuController };",
      resolveDir: packageDir,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    jsx: "automatic",
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "react-external",
        setup(builder) {
          builder.onResolve({ filter: /^react(?:\/.*)?$/ }, (args) => ({
            path: require.resolve(args.path),
            external: true,
          }));
        },
      },
    ],
  });
  const bundleDir = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-terminal-selection-menu-"),
  );
  const bundlePath = NodePath.join(bundleDir, "bundle.mjs");
  try {
    await NodeFSP.writeFile(bundlePath, built.outputFiles[0].text);
    ({ TerminalSelectionMenuController: Controller } = await import(
      NodeURL.pathToFileURL(bundlePath).href
    ));
  } finally {
    await NodeFSP.rm(bundleDir, { recursive: true, force: true });
  }
});

/** Timers the controller schedules on the global `window`, run by hand. */
function fakeWindow() {
  const pending = new Map();
  let next = 0;
  const add = (callback) => {
    pending.set(++next, callback);
    return next;
  };
  const cancel = (id) => pending.delete(id);
  return {
    pending,
    runAll() {
      while (pending.size > 0) {
        const [id, callback] = pending.entries().next().value;
        pending.delete(id);
        callback();
      }
    },
    setTimeout: add,
    clearTimeout: cancel,
    requestAnimationFrame: add,
    cancelAnimationFrame: cancel,
    innerWidth: 1024,
    innerHeight: 768,
  };
}

const listenerTarget = () => {
  const listeners = new Map();
  return {
    listeners,
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
    fire: (type, event) => listeners.get(type)?.(event),
  };
};

function mountMenu() {
  const view = listenerTarget();
  const document = { ...listenerTarget(), defaultView: view };
  const mount = {
    ...listenerTarget(),
    ownerDocument: document,
    contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
  };
  const surface = {
    focus() {},
    hasSelection: () => true,
    getSelection: () => "selected",
    getSelectionEndClientRect: () => ({ left: 40, top: 40, right: 60, bottom: 56 }),
  };
  const opened = [];
  const controller = new Controller(
    { getMount: () => mount, getSurface: () => surface, reportError() {} },
    (menu) => opened.push(menu?.kind ?? null),
  );
  const uninstall = controller.install(mount);
  // A primary-button selection gesture: press in the pane, release on the page.
  const select = (detail) => {
    mount.fire("pointerdown", { isPrimary: true, button: 0, defaultPrevented: false });
    view.fire("mouseup", { button: 0, detail, clientX: 50, clientY: 50 });
  };
  const outsidePress = () => document.fire("pointerdown", { composedPath: () => [{}] });
  return { opened, select, outsidePress, uninstall };
}

NodeTest.describe("terminal selection menu — pending popup", () => {
  let timers;
  NodeTest.beforeEach(() => {
    timers = fakeWindow();
    globalThis.window = timers;
  });
  NodeTest.afterEach(() => {
    delete globalThis.window;
  });

  NodeTest.it("a finished selection gesture opens the popup once its timer runs", () => {
    const { opened, select, uninstall } = mountMenu();
    select(2);
    NodeAssert.equal(timers.pending.size, 1);
    timers.runAll();
    NodeAssert.deepEqual(opened, ["selection"]);
    uninstall();
  });

  NodeTest.it("an outside press that keeps focus retires the pending popup", () => {
    const { opened, select, outsidePress, uninstall } = mountMenu();
    // A double-click selection waits out the multi-click interval.
    select(2);
    outsidePress();
    NodeAssert.equal(timers.pending.size, 0);
    timers.runAll();
    NodeAssert.equal(opened.includes("selection"), false);
    uninstall();
  });
});
