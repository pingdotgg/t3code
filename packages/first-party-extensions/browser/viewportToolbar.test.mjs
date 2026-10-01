/**
 * Component-level regressions over the REAL viewportToolbar.tsx, bundled by
 * esbuild into the system tmpdir (never into the package) and driven with
 * react-test-renderer. Events bubble through the rendered tree the way React
 * delivers them, and a mouse press that is not default-prevented moves focus
 * the way macOS Chromium does: clicked buttons do not take focus, so the
 * edited field blurs with no relatedTarget.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(new URL(".", import.meta.url));
const { build } = require("esbuild");
const React = require("react");
const { act, create } = require("react-test-renderer");

const packageDir = NodeURL.fileURLToPath(new URL(".", import.meta.url));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// The toolbar's blur check tests `relatedTarget instanceof Node`.
class FakeNode {
  constructor(instance) {
    this.instance = instance;
  }

  /** Whether this node renders inside `ancestor`, like `Node.contains`. */
  isWithin(ancestor) {
    for (let cursor = this.instance; cursor; cursor = cursor.parent)
      if (cursor === ancestor) return true;
    return false;
  }
}
globalThis.Node = FakeNode;

let BrowserViewportToolbar;
let useAspectLocks;

NodeTest.before(async () => {
  const built = await build({
    entryPoints: [NodePath.join(packageDir, "viewportToolbar.tsx")],
    bundle: true,
    write: false,
    jsx: "automatic",
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "external-react",
        setup(builder) {
          builder.onResolve({ filter: /^react(?:\/.*)?$/ }, (args) => ({
            path: require.resolve(args.path),
            external: true,
          }));
        },
      },
    ],
  });
  const bundleDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-viewport-toolbar-"));
  const bundlePath = NodePath.join(bundleDir, "bundle.mjs");
  try {
    await NodeFSP.writeFile(bundlePath, built.outputFiles[0].text);
    ({ BrowserViewportToolbar, useAspectLocks } = await import(
      NodeURL.pathToFileURL(bundlePath).href
    ));
  } finally {
    await NodeFSP.rm(bundleDir, { recursive: true, force: true });
  }
});

const IPHONE_SE = { _tag: "preset", presetId: "iphone-se", width: 375, height: 667 };

/**
 * Mounts the toolbar under a host that behaves like the panel: a commit
 * marks the toolbar pending until `land()` applies it as the new setting.
 */
function mountToolbar(setting) {
  const commits = [];
  let current = setting;
  let pending = false;
  let locked = false;
  // Each commit's acceptance, settled by `land()` / `reject()` like the panel's.
  const settles = [];
  let renderer;
  const render = () =>
    React.createElement(BrowserViewportToolbar, {
      // No host tooltip: controls render bare.
      host: { React },
      setting: current,
      pending,
      aspectLocked: locked,
      onAspectLockedChange: (next) => {
        locked = next;
        renderer.update(render());
      },
      onCommit: (next) => {
        commits.push(next);
        pending = true;
        renderer.update(render());
        return new Promise((resolve) => settles.push(resolve));
      },
    });
  act(() => {
    renderer = create(render());
  });
  return {
    commits,
    locked: () => locked,
    async land() {
      const next = commits.at(-1);
      await act(async () => {
        pending = false;
        if (next._tag !== "fill") current = next;
        renderer.update(render());
        settles.shift()?.(true);
      });
    },
    /** The commit is denied, times out or fails: the setting never changes. */
    async reject() {
      await act(async () => {
        pending = false;
        renderer.update(render());
        settles.shift()?.(false);
      });
    },
    find: (label) => renderer.root.find((node) => node.props["aria-label"] === label),
  };
}

/** Delivers a React synthetic event from `target` up through its ancestors. */
function dispatch(target, handler, init = {}) {
  const event = {
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    target: { value: init.value },
    ...init,
  };
  act(() => {
    for (let node = target; node && !event.propagationStopped; node = node.parent) {
      const listener = node.props?.[handler];
      if (typeof listener !== "function") continue;
      event.currentTarget = { contains: (other) => other?.isWithin(node) === true };
      listener(event);
    }
  });
  return event;
}

function typeInto(toolbar, label, value) {
  dispatch(toolbar.find(label), "onFocus");
  dispatch(toolbar.find(label), "onChange", { value });
}

/** Focus moves from `from` to `to` (null: a target that takes no focus). */
function moveFocus(toolbar, from, to) {
  dispatch(toolbar.find(from), "onBlur", {
    relatedTarget: to === null ? null : new FakeNode(toolbar.find(to)),
  });
}

/** A mouse click on a button while `focused` holds focus. */
function click(toolbar, label, focused) {
  const press = dispatch(toolbar.find(label), "onMouseDown");
  if (!press.defaultPrevented) moveFocus(toolbar, focused, null);
  const button = toolbar.find(label);
  if (!button.props.disabled) dispatch(button, "onClick");
}

NodeTest.describe("device toolbar dimension edits", () => {
  NodeTest.it("commits a typed width on Enter", () => {
    const toolbar = mountToolbar(IPHONE_SE);
    typeInto(toolbar, "Viewport width", "420");
    const enter = dispatch(toolbar.find("Viewport width"), "onKeyDown", { key: "Enter" });
    NodeAssert.deepEqual(toolbar.commits, [{ _tag: "freeform", width: 420, height: 667 }]);
    NodeAssert.equal(enter.defaultPrevented, true);
  });

  NodeTest.it("keeps an edit open while Tab moves within the toolbar, like native", () => {
    const toolbar = mountToolbar(IPHONE_SE);
    typeInto(toolbar, "Viewport width", "420");
    dispatch(toolbar.find("Viewport width"), "onKeyDown", { key: "Tab" });
    moveFocus(toolbar, "Viewport width", "Viewport height");
    NodeAssert.deepEqual(toolbar.commits, []);
    // Leaving the toolbar is the finished edit.
    moveFocus(toolbar, "Viewport height", null);
    NodeAssert.deepEqual(toolbar.commits, [{ _tag: "freeform", width: 420, height: 667 }]);
  });

  NodeTest.it("does not commit an unchanged or invalid size on Enter", () => {
    const toolbar = mountToolbar(IPHONE_SE);
    typeInto(toolbar, "Viewport width", "375");
    dispatch(toolbar.find("Viewport width"), "onKeyDown", { key: "Enter" });
    typeInto(toolbar, "Viewport width", "12");
    dispatch(toolbar.find("Viewport width"), "onKeyDown", { key: "Enter" });
    NodeAssert.deepEqual(toolbar.commits, []);
  });

  NodeTest.it("closes in one click while an edit is pending", () => {
    const toolbar = mountToolbar(IPHONE_SE);
    typeInto(toolbar, "Viewport width", "420");
    click(toolbar, "Close device toolbar", "Viewport width");
    NodeAssert.deepEqual(toolbar.commits, [{ _tag: "fill" }]);
  });

  NodeTest.it("rotates the pending edit in one click", () => {
    const toolbar = mountToolbar(IPHONE_SE);
    typeInto(toolbar, "Viewport width", "420");
    click(toolbar, "Rotate viewport", "Viewport width");
    NodeAssert.deepEqual(toolbar.commits, [{ _tag: "freeform", width: 667, height: 420 }]);
  });

  NodeTest.it("retires the edit once the committed size lands", async () => {
    const toolbar = mountToolbar(IPHONE_SE);
    typeInto(toolbar, "Viewport width", "420");
    dispatch(toolbar.find("Viewport width"), "onKeyDown", { key: "Enter" });
    await toolbar.land();
    NodeAssert.equal(toolbar.find("Viewport width").props.value, "420");
    NodeAssert.equal(toolbar.find("Viewport width").props.disabled, false);
  });
});

NodeTest.describe("device toolbar aspect-ratio lock", () => {
  const LOCK = "Lock viewport aspect ratio";
  const UNLOCK = "Unlock viewport aspect ratio";

  NodeTest.it("toggles like native: pressed while locked, relabelled to unlock", () => {
    const toolbar = mountToolbar(IPHONE_SE);
    NodeAssert.equal(toolbar.find(LOCK).props["aria-pressed"], false);
    click(toolbar, LOCK, "Viewport width");
    NodeAssert.equal(toolbar.locked(), true);
    NodeAssert.equal(toolbar.find(UNLOCK).props["aria-pressed"], true);
    click(toolbar, UNLOCK, "Viewport width");
    NodeAssert.equal(toolbar.locked(), false);
    // Toggling commits nothing: the lock is view state.
    NodeAssert.deepEqual(toolbar.commits, []);
  });

  NodeTest.it("derives the other dimension from a typed one while locked", () => {
    const toolbar = mountToolbar({ _tag: "freeform", width: 1280, height: 800 });
    click(toolbar, LOCK, "Viewport width");
    typeInto(toolbar, "Viewport height", "1000");
    NodeAssert.equal(toolbar.find("Viewport width").props.value, "1600");
    dispatch(toolbar.find("Viewport height"), "onKeyDown", { key: "Enter" });
    NodeAssert.deepEqual(toolbar.commits, [{ _tag: "freeform", width: 1600, height: 1000 }]);
  });

  NodeTest.it("leaves the other dimension alone while unlocked", () => {
    const toolbar = mountToolbar({ _tag: "freeform", width: 1280, height: 800 });
    typeInto(toolbar, "Viewport height", "1000");
    NodeAssert.equal(toolbar.find("Viewport width").props.value, "1280");
  });

  NodeTest.it("is unavailable for an invalid pending size", () => {
    const toolbar = mountToolbar(IPHONE_SE);
    typeInto(toolbar, "Viewport width", "12");
    NodeAssert.equal(toolbar.find(LOCK).props.disabled, true);
  });

  NodeTest.it("stays locked while Close is pending, releasing once it is accepted", async () => {
    const toolbar = mountToolbar(IPHONE_SE);
    click(toolbar, LOCK, "Viewport width");
    click(toolbar, "Close device toolbar", "Viewport width");
    NodeAssert.deepEqual(toolbar.commits, [{ _tag: "fill" }]);
    NodeAssert.equal(toolbar.locked(), true);
    await toolbar.land();
    NodeAssert.equal(toolbar.locked(), false);
  });

  NodeTest.it("keeps the lock when Close is rejected, like native", async () => {
    const toolbar = mountToolbar(IPHONE_SE);
    click(toolbar, LOCK, "Viewport width");
    click(toolbar, "Close device toolbar", "Viewport width");
    await toolbar.reject();
    NodeAssert.equal(toolbar.locked(), true);
    NodeAssert.equal(toolbar.find(UNLOCK).props["aria-pressed"], true);
  });
});

/**
 * The panel's lock state across tabs it adopts through its tab strip: the
 * hook as the panel holds it, fed the snapshot's tabs.
 */
function mountLocks(tabs, held = null) {
  let current = tabs;
  const hook = {};
  let renderer;
  function Probe() {
    hook.locks = useAspectLocks(current, held);
    return null;
  }
  act(() => {
    renderer = create(React.createElement(Probe));
  });
  return {
    isLocked: (tab) => hook.locks.isLocked(tab),
    set(tab, locked) {
      act(() => hook.locks.setLocked(tab, locked));
    },
    snapshot(nextTabs) {
      current = nextTabs;
      act(() => renderer.update(React.createElement(Probe)));
    },
  };
}

NodeTest.describe("aspect-ratio lock per tab", () => {
  const A = { tabId: "tab-a", serverEpoch: "epoch-1" };
  const B = { tabId: "tab-b", serverEpoch: "epoch-1" };

  NodeTest.it("keeps A's lock through A → B → A with both locked", () => {
    const locks = mountLocks([A, B]);
    locks.set(A, true);
    // Adopt B: it starts unlocked, then locks independently.
    NodeAssert.equal(locks.isLocked(B), false);
    locks.set(B, true);
    // Back to A.
    NodeAssert.equal(locks.isLocked(A), true);
    NodeAssert.equal(locks.isLocked(B), true);
  });

  NodeTest.it("closing B's device toolbar releases only B", () => {
    const locks = mountLocks([A, B]);
    locks.set(A, true);
    locks.set(B, false);
    NodeAssert.equal(locks.isLocked(A), true);
    locks.set(B, true);
    locks.set(B, false);
    NodeAssert.equal(locks.isLocked(A), true);
    NodeAssert.equal(locks.isLocked(B), false);
  });

  NodeTest.it("belongs to the epoch that minted the tab", () => {
    const locks = mountLocks([A]);
    locks.set(A, true);
    NodeAssert.equal(locks.isLocked({ ...A, serverEpoch: "epoch-2" }), false);
  });

  NodeTest.it("is dropped once the tab's session ends", () => {
    const locks = mountLocks([A, B]);
    locks.set(A, true);
    locks.set(B, true);
    locks.snapshot([B]);
    NodeAssert.equal(locks.isLocked(A), false);
    NodeAssert.equal(locks.isLocked(B), true);
    // A new server epoch ends every session of the old one.
    const restarted = { ...B, serverEpoch: "epoch-2" };
    locks.snapshot([restarted]);
    NodeAssert.equal(locks.isLocked(restarted), false);
  });

  NodeTest.it("locks a held tab whose first stream upsert has not arrived yet", () => {
    // Receipt adoption holds the tab before the stream lists it.
    const locks = mountLocks([], A);
    locks.set(A, true);
    NodeAssert.equal(locks.isLocked(A), true);
    // The upsert lands: the same lock, unchanged.
    locks.snapshot([A]);
    NodeAssert.equal(locks.isLocked(A), true);
  });
});

/**
 * The toolbar driven by the panel's lock hook for a held tab the stream has
 * not listed yet, as right after an accepted receipt.
 */
function mountHeldToolbar(held, setting) {
  let renderer;
  function Panel() {
    const locks = useAspectLocks([], held);
    return React.createElement(BrowserViewportToolbar, {
      host: { React },
      setting,
      pending: false,
      aspectLocked: locks.isLocked(held),
      onAspectLockedChange: (locked) => locks.setLocked(held, locked),
      onCommit: () => new Promise(() => {}),
    });
  }
  act(() => {
    renderer = create(React.createElement(Panel));
  });
  return {
    find: (label) => renderer.root.find((node) => node.props["aria-label"] === label),
    /** The lock button's pressed state, whichever label it carries now. */
    lockPressed: () =>
      renderer.root.find((node) => node.type === "button" && "aria-pressed" in node.props).props[
        "aria-pressed"
      ],
  };
}

NodeTest.describe("aspect-ratio lock before the first upsert", () => {
  NodeTest.it("the first click locks and the first edit keeps the shape", () => {
    const toolbar = mountHeldToolbar({ tabId: "tab-new", serverEpoch: "epoch-1" }, IPHONE_SE);
    click(toolbar, "Lock viewport aspect ratio", "Viewport width");
    NodeAssert.equal(toolbar.lockPressed(), true);
    typeInto(toolbar, "Viewport width", "420");
    NodeAssert.equal(
      toolbar.find("Viewport height").props.value,
      String(Math.round((420 * 667) / 375)),
    );
  });
});
