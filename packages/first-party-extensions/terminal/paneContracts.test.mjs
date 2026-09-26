// Pane-level contract regression: the published `--t3-terminal-*` appearance
// vars must reach the real VT surface — font at creation via `options.font`,
// live updates through `setFont`, and a reset back to the packaged defaults
// when the feed clears. Bundles the real TerminalPane with a recording
// GhosttyTerminalSurface boundary; no browser is involved. Also proves the
// local Ghostty editing intercepts exist: Ctrl+L writes U+000C to the PTY.

import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const packageDir = new URL("./", import.meta.url).pathname;
const require = NodeModule.createRequire(
  NodeURL.pathToFileURL(NodePath.join(packageDir, "../../extension-sdk/package.json")),
);
const { build } = require("esbuild");
const React = require("react");
const { create, act } = require("react-test-renderer");
const { terminalAppearanceVars } = await import("./viewModel.ts");

const recorded = { options: [], themes: [], fonts: [], input: [], focuses: [] };
globalThis.__vtPaneContracts = recorded;

// The bundle keeps workspace packages (`@t3tools/*`, react) external, so its
// private temp dir links the package's node_modules for resolution. It never
// lives in the package dir, which sibling test files copy concurrently.
const bundleDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-terminal-pane-contracts-"));
NodeFS.symlinkSync(
  NodePath.join(packageDir, "node_modules"),
  NodePath.join(bundleDir, "node_modules"),
);
const bundled = NodePath.join(bundleDir, "pane.mjs");
await build({
  stdin: {
    contents:
      NodeFS.readFileSync(NodePath.join(packageDir, "extension.tsx"), "utf8") +
      "\nexport { TerminalPane, handleBeforeKey };\n",
    resolveDir: packageDir,
    loader: "tsx",
  },
  outfile: bundled,
  jsx: "automatic",
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  plugins: [
    {
      name: "record-surface",
      setup(b) {
        b.onResolve({ filter: /^@t3tools\/ghostty-terminal\/surface$/ }, () => ({
          path: "surface",
          namespace: "probe",
        }));
        b.onLoad({ filter: /.*/, namespace: "probe" }, () => ({
          contents: `export class GhosttyTerminalSurface {
            static async create(mount, options) {
              globalThis.__vtPaneContracts.options.push(options);
              if (globalThis.__vtPaneContracts.delay)
                await new Promise((resolve) => {
                  globalThis.__vtPaneContracts.release = resolve;
                });
              return new this();
            }
            setTheme(theme) { globalThis.__vtPaneContracts.themes.push(theme); }
            async setFont(font) {
              globalThis.__vtPaneContracts.fonts.push(font);
              if (font.family === "Reject Mono") throw new Error("load rejection");
            }
            setVisible() {}
            focus() { globalThis.__vtPaneContracts.focuses.push("focus"); }
            write() {}
            resetAndWrite() {}
            dispose() {}
          }`,
          loader: "js",
        }));
      },
    },
  ],
});

let TerminalPane, handleBeforeKey;
try {
  ({ TerminalPane, handleBeforeKey } = await import(NodeURL.pathToFileURL(bundled).href));
} finally {
  NodeFS.rmSync(bundleDir, { recursive: true, force: true });
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};
const style = {
  colorScheme: "dark",
  backgroundColor: "rgb(10, 20, 30)",
  color: "rgb(200, 210, 220)",
  getPropertyValue: () => "",
};
globalThis.getComputedStyle = () => style;
globalThis.document = {
  body: {},
  documentElement: { classList: { contains: () => true } },
  createElement: () => ({
    getContext: () => ({
      clearRect() {},
      fillRect() {},
      getImageData() {
        return { data: [10, 20, 30, 255] };
      },
    }),
  }),
};

const controller = new AbortController();
const host = {
  subscribeApi: (_request, signal) => ({
    async *[Symbol.asyncIterator]() {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
  }),
};
const session = {
  signal: controller.signal,
  context: { resource: { threadId: "thread-1" } },
};
const panel = {
  resetInput() {},
  resize() {},
  sendInput(id, data) {
    recorded.input.push({ id, data });
  },
};
const assets = { kind: "ready", runtime: {}, symbolsFontUrl: "fixture-font" };

function resetRecorded() {
  recorded.options.length = 0;
  recorded.themes.length = 0;
  recorded.fonts.length = 0;
  recorded.input.length = 0;
  recorded.focuses.length = 0;
  recorded.delay = false;
  recorded.release = undefined;
}

const first = {
  appearance: "dark",
  theme: { background: "#123456", foreground: "#abcdef" },
  font: { family: "First Mono", size: 18 },
};
const second = { ...first, font: { family: "Second Mono", size: 24 } };

const props = {
  host,
  session,
  panel,
  terminalId: "terminal-1",
  streamKeyPrefix: "«contracts»",
  active: true,
  shown: true,
  visible: true,
  assets,
  themeVars: null,
  appearanceVars: terminalAppearanceVars(first),
};

NodeTest.test("published font vars reach the surface: create, update, reset", async () => {
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(TerminalPane, props), {
      createNodeMock: () => ({}),
    });
  });
  // Creation carries the already-published font — none of it waits for an
  // update cycle.
  NodeAssert.equal(recorded.options.length, 1);
  NodeAssert.deepEqual(recorded.options[0].font, { family: "First Mono", size: 18 });

  // A republished appearance drives setFont with the new family/size.
  await act(async () => {
    renderer.update(
      React.createElement(TerminalPane, {
        ...props,
        appearanceVars: terminalAppearanceVars(second),
      }),
    );
  });
  NodeAssert.deepEqual(recorded.fonts.at(-1), { family: "Second Mono", size: 24 });

  // A cleared feed resets the surface to its packaged defaults.
  await act(async () => {
    renderer.update(React.createElement(TerminalPane, { ...props, appearanceVars: null }));
  });
  NodeAssert.deepEqual(recorded.fonts.at(-1), {});

  // The same effect keeps the color pipeline live.
  NodeAssert.ok(recorded.themes.length >= 2);

  await act(async () => {
    renderer.unmount();
    controller.abort();
  });
});

// A publication that lands while `GhosttyTerminalSurface.create` is still
// pending must reconcile onto the new surface — the update effect sees
// surfaceRef null and its setFont is skipped, so the create continuation
// re-reads the latest vars after the await resolves.
NodeTest.test("republish during pending async create lands on the new surface", async () => {
  resetRecorded();
  recorded.delay = true;
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(TerminalPane, props), {
      createNodeMock: () => ({}),
    });
  });
  // Create is still pending; the republish's setFont is skipped.
  await act(async () => {
    renderer.update(
      React.createElement(TerminalPane, {
        ...props,
        appearanceVars: terminalAppearanceVars(second),
      }),
    );
  });
  NodeAssert.equal(recorded.fonts.length, 0);
  await act(async () => {
    recorded.release();
  });
  // The new surface was created with the pre-republish font, then
  // reconciled to the latest publication.
  NodeAssert.deepEqual(recorded.options[0].font, { family: "First Mono", size: 18 });
  NodeAssert.deepEqual(recorded.fonts.at(-1), { family: "Second Mono", size: 24 });
  await act(async () => {
    renderer.unmount();
  });
});

NodeTest.test("clear during pending async create resets the new surface", async () => {
  resetRecorded();
  recorded.delay = true;
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(TerminalPane, props), {
      createNodeMock: () => ({}),
    });
  });
  await act(async () => {
    renderer.update(React.createElement(TerminalPane, { ...props, appearanceVars: null }));
  });
  NodeAssert.equal(recorded.fonts.length, 0);
  await act(async () => {
    recorded.release();
  });
  NodeAssert.deepEqual(recorded.options[0].font, { family: "First Mono", size: 18 });
  NodeAssert.deepEqual(recorded.fonts.at(-1), {});
  await act(async () => {
    renderer.unmount();
  });
});

// A rejected setFont keeps current metrics and must not wedge the
// reconciliation — the next publication still reaches the surface.
NodeTest.test("a rejected setFont does not wedge later updates", async () => {
  resetRecorded();
  recorded.delay = true;
  const rejected = {
    ...first,
    font: { family: "Reject Mono", size: 20 },
  };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(TerminalPane, props), {
      createNodeMock: () => ({}),
    });
  });
  await act(async () => {
    renderer.update(
      React.createElement(TerminalPane, {
        ...props,
        appearanceVars: terminalAppearanceVars(rejected),
      }),
    );
  });
  await act(async () => {
    recorded.release();
  });
  // The reconciling setFont rejected — swallowed like the settled path.
  NodeAssert.deepEqual(recorded.fonts.at(-1), { family: "Reject Mono", size: 20 });
  await act(async () => {
    renderer.update(
      React.createElement(TerminalPane, {
        ...props,
        appearanceVars: terminalAppearanceVars(second),
      }),
    );
  });
  NodeAssert.deepEqual(recorded.fonts.at(-1), { family: "Second Mono", size: 24 });
  await act(async () => {
    renderer.unmount();
  });
});

NodeTest.test("local Ghostty editing intercepts exist: Ctrl+L writes FF to the PTY", () => {
  let prevented = false;
  let stopped = false;
  const result = handleBeforeKey(
    {
      type: "keydown",
      key: "l",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
    },
    panel,
    "terminal-1",
  );
  NodeAssert.equal(result, false);
  NodeAssert.ok(prevented && stopped);
  NodeAssert.deepEqual(recorded.input.at(-1), { id: "terminal-1", data: "\f" });
});

// A pane that is active+shown at mount — the fresh split case — must receive
// focus once its async surface creation completes. The [active, shown, visible]
// effect runs before the create resolves and its deps never change again for
// that pane, so without the creation-time reconciliation the new pane never
// takes focus and keystrokes land in the old pane's PTY.
NodeTest.test("active pane takes focus when its surface creation completes", async () => {
  resetRecorded();
  recorded.delay = true;
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(TerminalPane, props), {
      createNodeMock: () => ({}),
    });
  });
  // The create is still pending — no focus yet.
  NodeAssert.equal(recorded.focuses.length, 0);
  await act(async () => {
    recorded.release();
  });
  NodeAssert.deepEqual(recorded.focuses, ["focus"]);
  await act(async () => {
    renderer.unmount();
  });
});

// Same reconciliation without the artificial delay: a plain mount of an
// active pane focuses exactly once the surface exists.
NodeTest.test("active pane focuses on plain mount, once", async () => {
  resetRecorded();
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(TerminalPane, props), {
      createNodeMock: () => ({}),
    });
  });
  NodeAssert.deepEqual(recorded.focuses, ["focus"]);
  await act(async () => {
    renderer.unmount();
  });
});

// A pane that lost focus (or was never active) before its surface
// finished creating must NOT steal focus at creation time.
NodeTest.test("pane deactivated during pending create does not steal focus", async () => {
  resetRecorded();
  recorded.delay = true;
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(TerminalPane, props), {
      createNodeMock: () => ({}),
    });
  });
  await act(async () => {
    renderer.update(React.createElement(TerminalPane, { ...props, active: false }));
  });
  await act(async () => {
    recorded.release();
  });
  NodeAssert.equal(recorded.focuses.length, 0);
  await act(async () => {
    renderer.unmount();
  });
});
