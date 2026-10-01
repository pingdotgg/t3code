/**
 * Component-level regressions over the REAL extension.tsx tree, bundled by
 * esbuild with the Ghostty surface replaced by a recording stub. These pin
 * these regression shapes as tests: cold-restore stream budget, group-switch
 * waiter wake, focused-chord capture against the real host keymap resolver,
 * and path-link activation through t3.ui/editor.openPath.
 *
 * The bundle is written to the system tmpdir, never into the package, so
 * the shipped tree stays free of test-only builds.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(new URL(".", import.meta.url));
const { build } = require("esbuild");
const React = require("react");
const { act, create } = require("react-test-renderer");
const { hostKeybindings, loadHostKeymap, userRule } = await import("./fixtures/hostKeymap.mjs");
const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@t3tools/shared/keybindings");

const packageDir = NodeURL.fileURLToPath(new URL(".", import.meta.url));

// The DOM surface the view touches outside React: theme observation, focus
// listeners, and the canvas probe the (stubbed) renderer would use.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.getComputedStyle = () => ({
  colorScheme: "dark",
  backgroundColor: "rgb(10,20,30)",
  color: "rgb(200,210,220)",
  getPropertyValue: () => "",
});
const documentListeners = new Map();
globalThis.document = {
  body: {},
  documentElement: { classList: { contains: () => true } },
  createElement: () => ({
    getContext: () => ({
      clearRect() {},
      fillRect() {},
      getImageData: () => ({ data: [10, 20, 30, 255] }),
    }),
  }),
  addEventListener: (type, handler) => documentListeners.set(type, handler),
  removeEventListener: (type) => documentListeners.delete(type),
};

const surfaceStub = `
export class GhosttyTerminalSurface {
  static surfaces = [];
  static pending = [];
  static delay = false;
  static focusOwner = null;
  static async create(mount, options) {
    const surface = new this();
    surface.options = options;
    surface.mount = mount;
    surface.writes = [];
    GhosttyTerminalSurface.surfaces.push(surface);
    if (GhosttyTerminalSurface.delay) {
      await new Promise((resolve) => GhosttyTerminalSurface.pending.push(resolve));
    }
    return surface;
  }
  setTheme() {}
  async setFont() {}
  setVisible() {}
  write(data) {
    this.writes.push(data);
  }
  resetAndWrite(data) {
    this.writes.push(data);
  }
  dispose() {}
  focus() {
    GhosttyTerminalSurface.focusOwner = this;
  }
}
globalThis.__T3_TERMINAL_SURFACE_STUB__ = GhosttyTerminalSurface;
`;

let bundle;

NodeTest.before(async () => {
  const built = await build({
    stdin: {
      contents:
        NodeFS.readFileSync(NodePath.join(packageDir, "extension.tsx"), "utf8") +
        "\nexport { TerminalPane, TerminalView, streamHub, handleBeforeKey, restoreState };",
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
        name: "surface-stub",
        setup(builder) {
          builder.onResolve({ filter: /^@t3tools\/ghostty-terminal\/surface$/ }, () => ({
            path: "surface-stub",
            namespace: "surface-stub",
          }));
          builder.onLoad({ filter: /.*/, namespace: "surface-stub" }, () => ({
            contents: surfaceStub,
            loader: "js",
          }));
          // The link-activation path mounts a real surface, so the asset
          // load must finish — but the WASM runtime behind it stays stubbed.
          builder.onResolve({ filter: /^@t3tools\/ghostty-terminal\/runtime$/ }, () => ({
            path: "runtime-stub",
            namespace: "runtime-stub",
          }));
          builder.onLoad({ filter: /.*/, namespace: "runtime-stub" }, () => ({
            contents: "export async function loadGhosttyRuntime() { return { stub: true }; }",
            loader: "js",
          }));
          builder.onResolve({ filter: /^react(?:\/.*)?$/ }, (args) => ({
            path: require.resolve(args.path),
            external: true,
          }));
        },
      },
    ],
  });
  const bundleDir = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-terminal-components-"),
  );
  const bundlePath = NodePath.join(bundleDir, "bundle.mjs");
  try {
    await NodeFSP.writeFile(bundlePath, built.outputFiles[0].text);
    bundle = await import(NodeURL.pathToFileURL(bundlePath).href);
  } finally {
    await NodeFSP.rm(bundleDir, { recursive: true, force: true });
  }
});

const nodeMock = (element) => ({ id: element.props["aria-label"] });

const fireDocument = (type) => documentListeners.get(type)?.();

function sessionMetadata(terminalId) {
  return {
    terminalId,
    status: "running",
    label: "",
    hasRunningSubprocess: false,
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-09-24T00:00:00Z",
  };
}

/** A pane-output host that records which terminalIds hold live streams. */
function paneStreamHost() {
  const active = new Set();
  const host = {
    subscribeApi: (request, signal) => ({
      async *[Symbol.asyncIterator]() {
        const terminalId = request.input?.terminalId ?? "?";
        active.add(terminalId);
        try {
          await new Promise((resolve) =>
            signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }),
          );
        } finally {
          active.delete(terminalId);
        }
      },
    }),
  };
  return { host, active };
}

NodeTest.describe("cold restore stream budget", () => {
  NodeTest.test(
    "eight-session restore admits sessions/theme/appearance inside the cap",
    async () => {
      // Cold restore: pane effects run before the view's fixed-feed effects
      // and hidden panes take optional slots — the three fixed subscriptions
      // must land inside the cap for the panel to go live and New to enable.
      const active = new Set();
      const attempts = [];
      const rejects = [];
      const host = {
        readAsset: () => new Promise(() => {}),
        invokeApi: async () => ({ tokens: {}, cssVars: {} }),
        subscribeApi: (request, signal) => ({
          async *[Symbol.asyncIterator]() {
            const name = `${request.id}/${request.name}${
              request.input?.terminalId ? `/${request.input.terminalId}` : ""
            }`;
            attempts.push(name);
            if (active.size >= 8) {
              rejects.push(name);
              throw new Error("Plugin stream limit reached");
            }
            const instance = `${name}#${attempts.length}`;
            active.add(instance);
            try {
              if (request.name === "list") {
                // The real sessions stream opens with its snapshot — the frame
                // that takes a restored panel live.
                yield {
                  value: {
                    kind: "snapshot",
                    terminals: Array.from({ length: 8 }, (_, index) =>
                      sessionMetadata(`cold${index}`),
                    ),
                  },
                };
              }
              await new Promise((resolve) =>
                signal.aborted
                  ? resolve()
                  : signal.addEventListener("abort", resolve, { once: true }),
              );
            } finally {
              active.delete(instance);
            }
          },
        }),
      };
      const session = {
        signal: new AbortController().signal,
        context: { resource: { threadId: "t", environmentId: "e" } },
        visible: true,
        save() {},
        onVisibility: () => () => {},
        bindCommands: () => () => {},
        restoreState: {
          terminalIds: Array.from({ length: 8 }, (_, index) => `cold${index}`),
          activeTerminalId: "cold0",
        },
      };
      let renderer;
      await act(async () => {
        renderer = create(React.createElement(bundle.TerminalView, { host, session }), {
          createNodeMock: nodeMock,
        });
      });
      try {
        // No subscription was rejected — the fixed feeds preempted optional
        // hidden-pane slots instead of starting over the cap.
        NodeAssert.deepEqual(rejects, []);
        for (const method of ["list", "subscribeState", "subscribeTerminalAppearance"]) {
          NodeAssert.ok(
            attempts.some((name) => name.includes(`/${method}`)),
            `missing ${method} subscription`,
          );
        }
        // Exactly the cap in flight: 3 shared fixed feeds + the active pane +
        // the four hidden panes the budget still covers. The other three
        // hidden panes were refused honestly and wait for a free slot.
        NodeAssert.equal(active.size, 8);
        const paneStreams = [...active]
          .map((instance) => instance.replace(/#\d+$/, ""))
          .filter((name) => /\/subscribe\/cold\d+$/.test(name));
        NodeAssert.equal(paneStreams.length, 5);
        NodeAssert.ok(paneStreams.some((name) => name.endsWith("/cold0")));
        const newButton = renderer.root
          .findAllByType("button")
          .find((node) => node.children.includes("New terminal"));
        NodeAssert.equal(newButton.props.disabled, false);
      } finally {
        await act(async () => renderer.unmount());
      }
      NodeAssert.equal(active.size, 0);
      NodeAssert.deepEqual(
        attempts.filter((name) => name.includes("/list")),
        [attempts.find((name) => name.includes("/list"))],
      );
    },
  );
});

NodeTest.describe("group switch waiter wake", () => {
  NodeTest.test(
    "a group switch connects the newly visible pane after demotions drain",
    async () => {
      // Group switch, on real TerminalPane components: three fixed feeds plus
      // a1..a4/c fill the pool, b is hidden and unallocated. Reorder b first
      // and show only b and c — b's failed acquire must retry when the later
      // demotions of a1..a4 wake waiters, so the visible pane connects over
      // evicted streams.
      const { host, active } = paneStreamHost();
      const session = {
        signal: new AbortController().signal,
        context: { resource: { threadId: "t", environmentId: "e" } },
      };
      const panel = { resetInput() {}, resize() {}, sendInput() {} };
      const assets = { kind: "ready", runtime: {}, symbolsFontUrl: "fixture" };
      const paneProps = (terminalId) => ({
        host,
        session,
        panel,
        terminalId,
        streamKeyPrefix: "review",
        active: false,
        shown: true,
        visible: true,
        assets,
        themeVars: null,
        appearanceVars: null,
      });
      const releases = [];
      for (const key of ["sessions", "theme", "appearance"]) {
        releases.push(
          bundle.streamHub.acquireFixedFeed(key, { onFrame() {}, onStatus() {} }, () => {}),
        );
      }
      const render = (order, shown) =>
        React.createElement(
          React.Fragment,
          null,
          ...order.map((terminalId) =>
            React.createElement(bundle.TerminalPane, {
              ...paneProps(terminalId),
              key: terminalId,
              shown: shown.includes(terminalId),
            }),
          ),
        );
      let renderer;
      await act(async () => {
        renderer = create(
          render(["a1", "a2", "a3", "a4", "c", "b"], ["a1", "a2", "a3", "a4", "c"]),
          {
            createNodeMock: nodeMock,
          },
        );
      });
      try {
        // Sanity: the five visible panes hold the budget's mandatory slots and
        // the hidden pane's optional acquire was refused, not churned.
        NodeAssert.deepEqual([...active].sort(), ["a1", "a2", "a3", "a4", "c"]);
        NodeAssert.equal(bundle.streamHub.paneSlotAvailable(), false);
        await act(async () => {
          renderer.update(render(["b", "a1", "a2", "a3", "a4", "c"], ["b", "c"]));
        });
        // After the switch, the newly visible pane owns a stream: the
        // demotions of a1..a4 woke its waiter, which evicted one of them.
        NodeAssert.equal(active.has("b"), true);
        NodeAssert.equal(active.has("c"), true);
        const disconnected = renderer.root
          .findAllByType(bundle.TerminalPane)
          .find((node) => node.props.terminalId === "b")
          .findAll((node) => node.props["aria-label"] === "Stream budget");
        NodeAssert.equal(disconnected.length, 0);
      } finally {
        await act(async () => renderer.unmount());
      }
      for (const release of releases) release();
      await act(async () => {}); // drain the pumps' async teardown
      NodeAssert.equal(active.size, 0);
    },
  );
});

NodeTest.describe("hidden waiters retry at current visibility", () => {
  NodeTest.test("refused hidden waiters cannot seize demoted slots as mandatory", async () => {
    // Five visible panes fill the pool, four hidden panes and b are refused and
    // wait. Switching to [b, c] demotes a1..a4 — hidden waiters retry at their
    // current (still-hidden) priority, so the demoted slots go to the newly
    // visible b rather than to h1..h4.
    const { host, active } = paneStreamHost();
    const session = {
      signal: new AbortController().signal,
      context: { resource: { threadId: "t", environmentId: "e" } },
    };
    const panel = { resetInput() {}, resize() {}, sendInput() {} };
    const assets = { kind: "ready", runtime: {}, symbolsFontUrl: "fixture" };
    const paneProps = (terminalId) => ({
      host,
      session,
      panel,
      terminalId,
      streamKeyPrefix: "review",
      active: false,
      shown: true,
      visible: true,
      assets,
      themeVars: null,
      appearanceVars: null,
    });
    const releases = [];
    for (const key of ["sessions", "theme", "appearance"]) {
      releases.push(
        bundle.streamHub.acquireFixedFeed(key, { onFrame() {}, onStatus() {} }, () => {}),
      );
    }
    const ids = ["a1", "a2", "a3", "a4", "c", "h1", "h2", "h3", "h4", "b"];
    const render = (order, shown) =>
      React.createElement(
        React.Fragment,
        null,
        ...order.map((terminalId) =>
          React.createElement(bundle.TerminalPane, {
            ...paneProps(terminalId),
            key: terminalId,
            shown: shown.includes(terminalId),
          }),
        ),
      );
    let renderer;
    await act(async () => {
      renderer = create(render(ids, ["a1", "a2", "a3", "a4", "c"]), {
        createNodeMock: nodeMock,
      });
    });
    try {
      NodeAssert.deepEqual([...active].sort(), ["a1", "a2", "a3", "a4", "c"]);
      await act(async () => {
        renderer.update(render(["b", ...ids.slice(0, 9)], ["b", "c"]));
      });
      // The whole switch resolves inside the update's effect flush: the
      // demotion wakes resolve in bounded cycles, no polling.
      const paneB = renderer.root
        .findAllByType(bundle.TerminalPane)
        .find((node) => node.props.terminalId === "b");
      NodeAssert.equal(
        paneB.findAll((node) => node.props["aria-label"] === "Stream budget").length,
        0,
      );
      // The hidden waiters stayed optional: none of them holds a stream,
      // and the pool keeps evictable capacity for the next visible pane.
      for (const hidden of ["h1", "h2", "h3", "h4"]) {
        NodeAssert.equal(active.has(hidden), false);
      }
      NodeAssert.equal(bundle.streamHub.paneSlotAvailable(), true);
      // b evicted exactly one demoted a-pane; the rest demoted in place.
      NodeAssert.deepEqual([...active].sort(), ["a2", "a3", "a4", "b", "c"]);
    } finally {
      await act(async () => renderer.unmount());
    }
    for (const release of releases) release();
    await act(async () => {}); // drain the pumps' async teardown
    NodeAssert.equal(active.size, 0);
  });
});

NodeTest.describe("two full views sidebar switch", () => {
  NodeTest.test("the selected pane wins the stream budget in both placements", async () => {
    // Two complete TerminalView placements for one thread, eleven restored
    // sessions. Selecting b through its real sidebar callback demotes a1..a4 in
    // the left placement — the left placement's earlier refused hidden waiters
    // retry at hidden priority on those demotions, so the streams leave
    // c/h2..h5 and the visible b connects.
    const active = new Map();
    let counter = 0;
    const host = {
      readAsset: () => new Promise(() => {}),
      invokeApi: async () => ({ tokens: {}, cssVars: {} }),
      subscribeApi: (request, signal) => ({
        async *[Symbol.asyncIterator]() {
          const id = ++counter;
          active.set(id, request.input?.terminalId ?? request.name);
          try {
            await new Promise((resolve) =>
              signal.aborted
                ? resolve()
                : signal.addEventListener("abort", resolve, { once: true }),
            );
          } finally {
            active.delete(id);
          }
        },
      }),
    };
    const ids = ["a1", "a2", "a3", "a4", "h1", "h2", "h3", "h4", "h5", "b", "c"];
    const groups = [
      { id: "g", terminalIds: ["a1", "a2", "a3", "a4"] },
      ...ids.slice(4).map((terminalId) => ({ id: terminalId, terminalIds: [terminalId] })),
    ];
    const sessionFor = (activeId) => ({
      signal: new AbortController().signal,
      context: { resource: { threadId: "full", environmentId: "e" } },
      visible: true,
      save() {},
      onVisibility: () => () => {},
      bindCommands: () => () => {},
      restoreState: {
        terminalIds: ids,
        activeTerminalId: activeId,
        terminalGroups: groups,
        activeTerminalGroupId: activeId === "a1" ? "g" : activeId,
      },
    });
    let renderer;
    await act(async () => {
      renderer = create(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(bundle.TerminalView, {
            host,
            session: sessionFor("a1"),
            key: "left",
          }),
          React.createElement(bundle.TerminalView, {
            host,
            session: sessionFor("c"),
            key: "right",
          }),
        ),
        { createNodeMock: nodeMock },
      );
    });
    try {
      // The shared feeds (3) plus five pane slots sit exactly at the cap.
      NodeAssert.equal(active.size, 8);
      const leftTree = renderer.root.findAllByType(bundle.TerminalView)[0];
      const selectB = leftTree
        .find((node) => node.type === "li" && node.props["data-t3-terminal-session"] === "b")
        .findByType("button");
      await act(async () => selectB.props.onClick());
      const visible = leftTree
        .findAllByType(bundle.TerminalPane)
        .filter((node) => node.props.shown)
        .map((node) => ({
          id: node.props.terminalId,
          waiting: node.findAll((inner) => inner.props["aria-label"] === "Stream budget").length,
        }));
      NodeAssert.deepEqual(visible, [{ id: "b", waiting: 0 }]);
      NodeAssert.equal([...active.values()].includes("b"), true);
      NodeAssert.equal(active.size, 8);
    } finally {
      await act(async () => renderer.unmount());
    }
    NodeAssert.equal(active.size, 0);
  });
});

NodeTest.describe("stream admission order (terminal-stream-admission-order)", () => {
  NodeTest.test(
    "a pane taking an evicted slot opens its stream after the victim's teardown",
    async () => {
      // R5: the new pane's pump started inside the acquire that evicted the
      // victim, while the victim's host-level unsubscribe resolves on the
      // microtask queue — under a full broker the two raced for one slot.
      // The recording host pins the order: the replacement's subscription
      // open must land after the evicted pane's teardown resolved.
      const events = [];
      const host = {
        subscribeApi: (request, signal) => ({
          async *[Symbol.asyncIterator]() {
            const id = request.input?.terminalId ?? request.id;
            events.push(`open:${id}`);
            try {
              await new Promise((resolve) =>
                signal.aborted
                  ? resolve()
                  : signal.addEventListener("abort", resolve, { once: true }),
              );
              // The broker's host-level teardown resolves on the microtask
              // queue after the abort.
              await new Promise((resolve) => queueMicrotask(resolve));
              events.push(`teardown:${id}`);
            } finally {
              events.push(`end:${id}`);
            }
          },
        }),
      };
      const session = {
        signal: new AbortController().signal,
        context: { resource: { threadId: "admission", environmentId: "e" } },
      };
      const panel = { resetInput() {}, resize() {}, sendInput() {} };
      const assets = { kind: "ready", runtime: {}, symbolsFontUrl: "fixture" };
      const ids = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "h"];
      const paneProps = (terminalId, shown) => ({
        host,
        session,
        panel,
        terminalId,
        streamKeyPrefix: "admission",
        active: false,
        shown,
        visible: true,
        assets,
        themeVars: null,
        appearanceVars: null,
      });
      const render = (mountIds, shownIds) =>
        React.createElement(
          React.Fragment,
          null,
          ...mountIds.map((terminalId) =>
            React.createElement(bundle.TerminalPane, {
              ...paneProps(terminalId, shownIds.includes(terminalId)),
              key: terminalId,
            }),
          ),
        );
      // Seven mandatory panes plus one optional (the hidden pane) fill the
      // pool; a ninth visible pane can only get a slot by evicting it.
      let renderer;
      await act(async () => {
        renderer = create(render(ids, ids.slice(0, 7)), { createNodeMock: nodeMock });
      });
      try {
        await act(async () => {
          renderer.update(render([...ids, "b"], [...ids.slice(0, 7), "b"]));
        });
        NodeAssert.ok(events.includes("open:b"), `replacement never opened: ${events.join(",")}`);
        NodeAssert.ok(
          events.includes("teardown:h"),
          `victim teardown never resolved: ${events.join(",")}`,
        );
        NodeAssert.ok(
          events.indexOf("teardown:h") < events.indexOf("open:b"),
          `the replacement opened before the victim's teardown resolved: ${events.join(",")}`,
        );
      } finally {
        await act(async () => renderer.unmount());
      }
    },
  );
});

NodeTest.describe("broker-shared budget (terminal-broker-shared-budget)", () => {
  NodeTest.test(
    "a pane refused by the broker waits honestly and attaches when capacity returns",
    async () => {
      // R6: the hub's client-side budget cannot see another client
      // document of the same installation — the broker's refusal is the
      // authoritative accounting. Pre-fix the refusal surfaced as the
      // pane's transport error ("Plugin stream limit reached") and the
      // pane never retried. Now it shows the same waiting notice as a
      // refused hub acquire and retries with backoff until the other
      // client releases.
      let otherClientHolds = true;
      const opens = [];
      const host = {
        subscribeApi: (request, signal) => ({
          async *[Symbol.asyncIterator]() {
            if (request.name === "subscribe") {
              if (otherClientHolds) throw new Error("Plugin stream limit reached");
              opens.push(request.input?.terminalId);
            }
            try {
              await new Promise((resolve) =>
                signal.aborted
                  ? resolve()
                  : signal.addEventListener("abort", resolve, { once: true }),
              );
            } finally {
              if (request.name === "subscribe") {
                const index = opens.indexOf(request.input?.terminalId);
                if (index >= 0) opens.splice(index, 1);
              }
            }
          },
        }),
      };
      const session = {
        signal: new AbortController().signal,
        context: { resource: { threadId: "budget", environmentId: "e" } },
      };
      const panel = { resetInput() {}, resize() {}, sendInput() {} };
      const assets = { kind: "ready", runtime: {}, symbolsFontUrl: "fixture" };
      let renderer;
      await act(async () => {
        renderer = create(
          React.createElement(bundle.TerminalPane, {
            host,
            session,
            panel,
            terminalId: "shared",
            streamKeyPrefix: "budget",
            active: false,
            shown: true,
            visible: true,
            assets,
            themeVars: null,
            appearanceVars: null,
          }),
          { createNodeMock: nodeMock },
        );
      });
      const waiting = () =>
        renderer.root.findAll((node) => node.props["aria-label"] === "Stream budget").length;
      const statusText = () =>
        renderer.root
          .find((node) => node.props["aria-label"] === "Output status")
          .children.join("");
      try {
        // Refused once: the honest waiting notice, and the pane is NOT in
        // error — the refusal never reached the attachment.
        NodeAssert.equal(waiting(), 1);
        NodeAssert.doesNotMatch(statusText(), /limit reached/);
        NodeAssert.doesNotMatch(statusText(), /error/i);
        // The other client releases; the backoff retry (400ms) attaches.
        otherClientHolds = false;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 550));
        });
        NodeAssert.equal(waiting(), 0);
        NodeAssert.deepEqual(opens, ["shared"]);
      } finally {
        await act(async () => renderer.unmount());
      }
    },
  );

  NodeTest.test(
    "a refused sessions list stays connecting and goes live once capacity returns",
    async () => {
      // The same broker refusal on the sessions feed: the panel must not
      // burn its closed-stream attempts on capacity, nor disable New over
      // it — it stays "connecting" through the backoff and the retry's
      // snapshot takes it live.
      let listRefusals = 0;
      const host = {
        readAsset: () => new Promise(() => {}),
        invokeApi: async () => ({ tokens: {}, cssVars: {} }),
        subscribeApi: (request, signal) => ({
          async *[Symbol.asyncIterator]() {
            if (request.name === "list") {
              if (listRefusals < 1) {
                listRefusals += 1;
                throw new Error("Plugin stream limit reached");
              }
              yield { value: { kind: "snapshot", terminals: [] } };
            }
            await new Promise((resolve) =>
              signal.aborted
                ? resolve()
                : signal.addEventListener("abort", resolve, { once: true }),
            );
          },
        }),
      };
      const session = {
        signal: new AbortController().signal,
        context: { resource: { threadId: "budget-view", environmentId: "e" } },
        visible: true,
        save() {},
        onVisibility: () => () => {},
        bindCommands: () => () => {},
      };
      let renderer;
      await act(async () => {
        renderer = create(React.createElement(bundle.TerminalView, { host, session }), {
          createNodeMock: nodeMock,
        });
      });
      const newButton = () =>
        renderer.root
          .findAllByType("button")
          .find((node) => node.children.includes("New terminal"));
      const headerStatus = () =>
        renderer.root
          .findAllByType("span")
          .map((node) => node.children.join(""))
          .find((text) => /Connecting|disconnected/.test(text));
      try {
        // Through the refusal: honest "connecting", New gated on live — but
        // the panel is not disconnected over capacity.
        NodeAssert.match(headerStatus(), /Connecting/);
        NodeAssert.equal(newButton().props.disabled, true);
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 550));
        });
        // The retry's snapshot took the panel live.
        NodeAssert.equal(headerStatus(), undefined);
        NodeAssert.equal(newButton().props.disabled, false);
      } finally {
        await act(async () => renderer.unmount());
      }
    },
  );
});

/**
 * A full TerminalView over one restored, live pane, with the capture →
 * VT-target traversal a real key press takes. The ChatView host-capture step
 * lives outside this package; `press` starts at the event it yields. `encoded`
 * is the byte sequence the packaged Ghostty encoder produced for that event —
 * what reaches the PTY if nothing claims it.
 */
async function mountKeyView({ keybindings, invokeKeymap }) {
  const invokes = [];
  const active = new Map();
  let counter = 0;
  let setVisibility = () => {};
  const host = {
    readAsset: () => new Promise(() => {}),
    ...(keybindings === undefined ? {} : { keybindings }),
    invokeApi: (request) => {
      invokes.push({ method: request.method, input: request.input });
      if (request.method === "listConflicts") return invokeKeymap();
      if (["open", "attach", "restart"].includes(request.method)) {
        return Promise.resolve(sessionMetadata(request.input?.terminalId ?? "keypane"));
      }
      return Promise.resolve({ tokens: {}, cssVars: {} });
    },
    subscribeApi: (request, signal) => ({
      async *[Symbol.asyncIterator]() {
        const id = ++counter;
        active.set(id, request.input?.terminalId ?? request.name);
        try {
          if (request.name === "list") {
            yield { value: { kind: "snapshot", terminals: [sessionMetadata("keypane")] } };
          }
          await new Promise((resolve) =>
            signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }),
          );
        } finally {
          active.delete(id);
        }
      },
    }),
  };
  const session = {
    signal: new AbortController().signal,
    context: {
      resource: { threadId: "keys", environmentId: "e" },
      workspaceRevision: JSON.stringify(["/private/tmp/t3-host-keybinding-resolve", null]),
    },
    visible: true,
    save() {},
    onVisibility: (listener) => {
      setVisibility = listener;
      return () => {
        setVisibility = () => {};
      };
    },
    bindCommands: () => () => {},
    restoreState: { terminalIds: ["keypane"], activeTerminalId: "keypane" },
  };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(bundle.TerminalView, { host, session }), {
      createNodeMock: nodeMock,
    });
  });
  const pty = [];
  const press = async (event, encoded) => {
    await act(async () => {
      renderer.root.findByType("section").props.onKeyDownCapture({
        get defaultPrevented() {
          return event.defaultPrevented;
        },
        nativeEvent: event,
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
      });
    });
    if (
      !event.stopped &&
      bundle.handleBeforeKey(
        event,
        { sendInput: (_id, data) => pty.push(data) },
        "keypane",
        undefined,
        "bound",
      ) &&
      encoded !== undefined
    ) {
      pty.push(encoded);
    }
    return { prevented: event.defaultPrevented, stopped: event.stopped };
  };
  return {
    press,
    pty,
    invokes,
    active,
    opened: () => invokes.filter(({ method }) => method === "open").length,
    setVisible: (visible) => act(async () => setVisibility(visible)),
    unmount: () => act(async () => renderer.unmount()),
  };
}

const setPlatform = (platform) =>
  Object.defineProperty(globalThis, "navigator", { value: { platform }, configurable: true });

/** A Linux keydown as the host yields it to the surface's capture phase. */
const linuxKey = (key, { ctrl = true, shift = false, code } = {}) => ({
  key,
  code: code ?? `Key${key.toUpperCase()}`,
  metaKey: false,
  ctrlKey: ctrl,
  altKey: false,
  shiftKey: shift,
  repeat: false,
  isComposing: false,
  getModifierState: () => false,
  defaultPrevented: false,
  stopped: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
  stopPropagation() {
    this.stopped = true;
  },
});
const CTRL_SHIFT_J = () => linuxKey("J", { shift: true });
const CTRL_SHIFT_T = () => linuxKey("T", { shift: true });
const CTRL_SHIFT_C = () => linuxKey("C", { shift: true });
const CTRL_PERIOD = () => linuxKey(".", { code: "Period" });
const PASSED = { prevented: false, stopped: false };
const CLAIMED = { prevented: true, stopped: true };

NodeTest.describe(
  "focused chords resolve through the host keymap (host-keybinding-resolve-api)",
  () => {
    let keymap;
    NodeTest.before(async () => {
      keymap = await loadHostKeymap();
    });

    NodeTest.test(
      "a foreign shifted remap splits from the first press, before and after focus, with no PTY bytes",
      async () => {
        // The Browser's mod+shift+j remapped to terminal.split. The plugin
        // asks the host resolver synchronously, so there is no window where
        // a stale listConflicts answer decides the key: the chord splits and
        // no `ESC[106;6u` reaches the shell, and the plugin never calls
        // listConflicts at all.
        setPlatform("Linux x86_64");
        let rules = [...DEFAULT_RESOLVED_KEYBINDINGS, userRule("terminal.split", "mod+shift+j")];
        // Keymap scheduling: the mount-time answer ([]) lands before focus,
        // and every later request stays outstanding.
        let keymapCalls = 0;
        const view = await mountKeyView({
          keybindings: hostKeybindings(keymap, () => rules),
          invokeKeymap: () =>
            ++keymapCalls === 1 ? Promise.resolve({ conflicts: [] }) : new Promise(() => {}),
        });
        try {
          // Right after mount, before the surface has focus.
          NodeAssert.deepEqual(await view.press(CTRL_SHIFT_J(), "\u001b[106;6u"), CLAIMED);
          NodeAssert.equal(view.opened(), 1);
          // After the first focus edge.
          await act(async () => fireDocument("focusin"));
          NodeAssert.deepEqual(await view.press(CTRL_SHIFT_J(), "\u001b[106;6u"), CLAIMED);
          NodeAssert.equal(view.opened(), 2);
          // An unowned shifted chord still reaches the shell.
          NodeAssert.deepEqual(await view.press(CTRL_SHIFT_T(), "\u001b[116;6u"), PASSED);
          // A remap introduced while the last answer had no native row: a
          // plain-mod foreign chord leaks until the user maps
          // it, then the very next press splits — the keymap is read live.
          NodeAssert.deepEqual(await view.press(CTRL_PERIOD(), "\u001b[46;5u"), PASSED);
          rules = [...rules, userRule("terminal.split", "mod+.")];
          NodeAssert.deepEqual(await view.press(CTRL_PERIOD(), "\u001b[46;5u"), CLAIMED);
          NodeAssert.equal(view.opened(), 3);
          NodeAssert.deepEqual(view.pty, ["\u001b[116;6u", "\u001b[46;5u"]);
          NodeAssert.equal(
            view.invokes.filter(({ method }) => method === "listConflicts").length,
            0,
          );
        } finally {
          await view.unmount();
        }
        NodeAssert.equal(view.active.size, 0);
      },
    );

    NodeTest.test(
      "a rejected keymap call and hide/show never swallow unowned shifted chords",
      async () => {
        // With a keymap call rejecting and across a hide/show cycle, no
        // shifted-mod class is held while a request is pending: unowned
        // chords such as Ctrl+Shift+T reach the shell and owned ones still
        // dispatch. Call sequence: answered, then rejected, then every later
        // request outstanding.
        setPlatform("Linux x86_64");
        let keymapCalls = 0;
        const view = await mountKeyView({
          keybindings: hostKeybindings(keymap, () => DEFAULT_RESOLVED_KEYBINDINGS),
          invokeKeymap: () => {
            keymapCalls += 1;
            if (keymapCalls === 1) return Promise.resolve({ conflicts: [] });
            if (keymapCalls === 2) return Promise.reject(new Error("listConflicts rejected"));
            return new Promise(() => {});
          },
        });
        try {
          NodeAssert.deepEqual(await view.press(CTRL_SHIFT_T(), "\u001b[116;6u"), PASSED);
          await act(async () => fireDocument("focusin"));
          fireDocument("focusout");
          await act(async () => fireDocument("focusin"));
          // After a rejected refresh, with the next request outstanding.
          NodeAssert.deepEqual(await view.press(CTRL_SHIFT_T(), "\u001b[116;6u"), PASSED);
          await view.setVisible(false);
          await view.setVisible(true);
          // The first presses after re-show.
          NodeAssert.deepEqual(await view.press(CTRL_SHIFT_T(), "\u001b[116;6u"), PASSED);
          NodeAssert.deepEqual(await view.press(linuxKey("t"), "\u0014"), PASSED);
          NodeAssert.deepEqual(await view.press(CTRL_SHIFT_C(), "\u001b[99;6u"), PASSED);
          // An owned chord right after re-show dispatches exactly once.
          NodeAssert.deepEqual(await view.press(linuxKey("d"), "\u0004"), CLAIMED);
          NodeAssert.equal(view.opened(), 1);
          NodeAssert.deepEqual(view.pty, [
            "\u001b[116;6u",
            "\u001b[116;6u",
            "\u001b[116;6u",
            "\u0014",
            "\u001b[99;6u",
          ]);
        } finally {
          await view.unmount();
        }
        NodeAssert.equal(view.active.size, 0);
      },
    );

    NodeTest.test("a host without the resolver keeps the shipped default chords", async () => {
      // Pre-1.1.0 hosts (or no t3.ui/keybindings grant): no host.keybindings.
      // The default chords still split; nothing else is held.
      setPlatform("Linux x86_64");
      const view = await mountKeyView({
        keybindings: undefined,
        invokeKeymap: () => new Promise(() => {}),
      });
      try {
        NodeAssert.deepEqual(await view.press(linuxKey("d"), "\u0004"), CLAIMED);
        NodeAssert.equal(view.opened(), 1);
        NodeAssert.deepEqual(await view.press(CTRL_SHIFT_J(), "\u001b[106;6u"), PASSED);
        NodeAssert.deepEqual(view.pty, ["\u001b[106;6u"]);
      } finally {
        await view.unmount();
      }
      NodeAssert.equal(view.active.size, 0);
    });
  },
);

// After an app/backend restart the restored pane sat "closed"
// until Start was clicked. Native attaches every pane it shows with the
// launch cwd, which starts a session the server no longer has.
NodeTest.test("a shown restored pane with no server session starts without a click", async () => {
  const drain = () => new Promise((resolve) => setImmediate(resolve));
  const invokes = [];
  const host = {
    readAsset: async (path) => ({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: path.endsWith(".woff2")
        ? "font/woff2"
        : path.endsWith(".txt")
          ? "text/plain"
          : "application/wasm",
      sha256: "0".repeat(64),
    }),
    invokeApi: async (request) => {
      invokes.push({ id: request.id, method: request.method, input: request.input });
      if (request.id === "t3.terminal/control" && request.method === "attach")
        return sessionMetadata(request.input.terminalId);
      if (request.id === "t3.ui/theme" && request.method === "getTokens")
        return { tokens: {}, cssVars: {} };
      return { commandSetToken: "token", results: [] };
    },
    subscribeApi: (request, signal) => ({
      async *[Symbol.asyncIterator]() {
        // The restarted server lists no sessions for this thread.
        if (request.id === "t3.terminal/sessions" && request.name === "list")
          yield { value: { kind: "snapshot", terminals: [] } };
        await new Promise((resolve) =>
          signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }),
        );
      },
    }),
  };
  const session = {
    signal: new AbortController().signal,
    context: {
      resource: { threadId: "t", environmentId: "e" },
      workspaceRevision: JSON.stringify(["/ws/root", null]),
    },
    visible: true,
    save() {},
    onVisibility: () => () => {},
    bindCommands: () => () => {},
    // r1 is shown; r2 is in another group, so it stays mounted offscreen.
    restoreState: { terminalIds: ["r1", "r2"], activeTerminalId: "r1" },
  };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(bundle.TerminalView, { host, session }), {
      createNodeMock: nodeMock,
    });
  });
  try {
    for (let attempt = 0; attempt < 10; attempt++)
      await act(async () => {
        await drain();
      });
    const controls = invokes.filter(
      (entry) => entry.id === "t3.terminal/control" && entry.method !== "resize",
    );
    NodeAssert.deepEqual(
      controls.map(({ method, input }) => [method, input.terminalId, input.cwd]),
      [["attach", "r1", "/ws/root"]],
    );
  } finally {
    await act(async () => {
      renderer.unmount();
    });
  }
});

NodeTest.describe("path link activation (Terminal 22 path half)", () => {
  const drain = () => new Promise((resolve) => setImmediate(resolve));
  // The stub class exists only inside the esbuild bundle; it publishes itself.
  const stubSurfaces = () => globalThis.__T3_TERMINAL_SURFACE_STUB__.surfaces;
  // The count this feature owns — other invokes may share the window.
  const editorInvokes = (invokes) =>
    invokes.filter((entry) => entry.id === "t3.ui/editor" && entry.method === "openPath");

  /** A host whose assets resolve, so the pane really mounts its surface. */
  function linkHost(openPath) {
    const invokes = [];
    const host = {
      readAsset: async (path) => ({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: path.endsWith(".woff2")
          ? "font/woff2"
          : path.endsWith(".txt")
            ? "text/plain"
            : "application/wasm",
        sha256: "0".repeat(64),
      }),
      invokeApi: async (request) => {
        invokes.push({ id: request.id, method: request.method, input: request.input });
        if (request.id === "t3.ui/editor" && request.method === "openPath")
          return openPath(request.input);
        if (request.id === "t3.ui/theme" && request.method === "getTokens")
          return { tokens: {}, cssVars: {} };
        if (request.id === "t3.ui/external" && request.method === "openLink")
          return { status: "refused", reason: "opener-refused" };
        return { commandSetToken: "token", results: [] };
      },
      // A current host: t3.ui/external routes links by the user's setting.
      discoverApis: async () => [{ id: "t3.ui/external", version: "1.1.0" }],
      subscribeApi: (request, signal) => ({
        async *[Symbol.asyncIterator]() {
          if (request.id === "t3.terminal/sessions" && request.name === "list") {
            yield { value: { kind: "snapshot", terminals: [sessionMetadata("link1")] } };
          }
          await new Promise((resolve) =>
            signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }),
          );
        },
      }),
    };
    return { host, invokes };
  }

  function workspaceSession() {
    return {
      signal: new AbortController().signal,
      context: {
        resource: { threadId: "t", environmentId: "e" },
        workspaceRevision: JSON.stringify(["/ws/root", "/ws/worktrees/feature"]),
      },
      visible: true,
      save() {},
      onVisibility: () => () => {},
      bindCommands: () => () => {},
      restoreState: { terminalIds: ["link1"], activeTerminalId: "link1" },
    };
  }

  /** Mounts the pane and returns its link activator and surface. */
  async function mountLinkPane(host, session = workspaceSession()) {
    stubSurfaces().length = 0;
    let renderer;
    await act(async () => {
      renderer = create(React.createElement(bundle.TerminalView, { host, session }), {
        createNodeMock: nodeMock,
      });
    });
    // The pane's surface mounts only after the shared asset load lands.
    for (let attempt = 0; stubSurfaces().length === 0 && attempt < 20; attempt++) {
      await act(async () => {
        await drain();
      });
    }
    const surface = stubSurfaces()[0];
    NodeAssert.ok(surface, "terminal surface never mounted");
    const activate = async (text, event = { metaKey: true, ctrlKey: false }) => {
      surface.writes.length = 0;
      await act(async () => {
        surface.options.onLinkActivate(text, event);
        await drain();
      });
      return surface.writes.filter((data) => data.includes("[terminal]"));
    };
    const unmount = () =>
      act(async () => {
        renderer.unmount();
      });
    return { activate, unmount };
  }

  NodeTest.test(
    "path links open the preferred editor at the link position, URLs open through t3.ui/external's setting-aware openLink",
    async () => {
      const { host, invokes } = linkHost((input) => ({
        status: "opened",
        path: `${input.cwd}/${input.path}`,
        editor: "zed",
      }));
      const pane = await mountLinkPane(host);
      try {
        // Like the native drawer: raw link text plus the launch cwd (the
        // thread worktree), position intact, and a successful open is silent.
        NodeAssert.deepEqual(await pane.activate("src/view.tsx:12:3"), []);
        // A path outside the project root is still the user's to open.
        NodeAssert.deepEqual(await pane.activate("/elsewhere/other.ts:4"), []);
        NodeAssert.deepEqual(
          editorInvokes(invokes).map((entry) => entry.input),
          [
            { path: "src/view.tsx:12:3", cwd: "/ws/worktrees/feature" },
            { path: "/elsewhere/other.ts:4", cwd: "/ws/worktrees/feature" },
          ],
        );
        // The Files view and file presentation are never involved.
        NodeAssert.deepEqual(
          invokes.filter(
            (entry) =>
              entry.id === "t3.file/presentation" ||
              (entry.id === "t3.ui/panels" && entry.method !== "getCapabilities"),
          ),
          [],
        );

        // URL link: handed to t3.ui/external, never the editor; the
        // client's refusal is written on the surface by name.
        const editorCount = editorInvokes(invokes).length;
        NodeAssert.deepEqual(await pane.activate("https://t3.codes/docs"), [
          "\r\n[terminal] https://t3.codes/docs was not opened (opener-refused).\r\n",
        ]);
        NodeAssert.equal(editorInvokes(invokes).length, editorCount);
        // A plain click leaves the destination to the host's "Open
        // links in" setting; only Cmd/Ctrl-click forces the system browser.
        await pane.activate("https://t3.codes/app", { metaKey: false, ctrlKey: false });
        await pane.activate("https://t3.codes/ctrl", { metaKey: false, ctrlKey: true });
        NodeAssert.deepEqual(
          invokes
            .filter((entry) => entry.id === "t3.ui/external")
            .map(({ id, method, input }) => ({ id, method, input })),
          [
            {
              id: "t3.ui/external",
              method: "openLink",
              input: { url: "https://t3.codes/docs", forceSystem: true },
            },
            { id: "t3.ui/external", method: "openLink", input: { url: "https://t3.codes/app" } },
            {
              id: "t3.ui/external",
              method: "openLink",
              input: { url: "https://t3.codes/ctrl", forceSystem: true },
            },
          ],
        );
      } finally {
        await pane.unmount();
      }
    },
  );

  NodeTest.test("the host's refusal and a denied open are written on the surface", async () => {
    let answer = { status: "refused", reason: "no-editor", message: "No available editor." };
    const { host } = linkHost(() => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const pane = await mountLinkPane(host);
    try {
      NodeAssert.deepEqual(await pane.activate("src/view.tsx"), [
        "\r\n[terminal] No available editor.\r\n",
      ]);
      answer = new Error("API capability denied: t3.ui/editor.open");
      NodeAssert.deepEqual(await pane.activate("src/view.tsx"), [
        "\r\n[terminal] src/view.tsx could not be opened — Needs permission t3.ui/editor.open. Grant it in Settings → Extensions.\r\n",
      ]);
    } finally {
      await pane.unmount();
    }
  });

  NodeTest.test("a session without a workspace reports it on the surface", async () => {
    const { host, invokes } = linkHost(() => {
      throw new Error("unreachable");
    });
    const session = workspaceSession();
    session.context.workspaceRevision = undefined;
    const pane = await mountLinkPane(host, session);
    try {
      NodeAssert.deepEqual(await pane.activate("src/a.ts"), [
        "\r\n[terminal] src/a.ts cannot be opened — the workspace is not available.\r\n",
      ]);
      NodeAssert.equal(editorInvokes(invokes).length, 0);
    } finally {
      await pane.unmount();
    }
  });
});

NodeTest.describe("session list with many sessions (Terminal 27b)", () => {
  /** Renders the panel over `count` live sessions with a resolving renderer. */
  async function renderSessions(count) {
    const ids = Array.from({ length: count }, (_, index) => `many${index + 1}`);
    const host = {
      readAsset: async (path) => ({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: path.endsWith(".woff2")
          ? "font/woff2"
          : path.endsWith(".txt")
            ? "text/plain"
            : "application/wasm",
        sha256: "0".repeat(64),
      }),
      invokeApi: async (request) =>
        request.id === "t3.ui/theme" && request.method === "getTokens"
          ? { tokens: {}, cssVars: {} }
          : { commandSetToken: "token", results: [] },
      subscribeApi: (request, signal) => ({
        async *[Symbol.asyncIterator]() {
          if (request.id === "t3.terminal/sessions" && request.name === "list")
            yield { value: { kind: "snapshot", terminals: ids.map(sessionMetadata) } };
          await new Promise((resolve) =>
            signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }),
          );
        },
      }),
    };
    const session = {
      signal: new AbortController().signal,
      context: { resource: { threadId: "t", environmentId: "e" } },
      visible: true,
      save() {},
      onVisibility: () => () => {},
      bindCommands: () => () => {},
      restoreState: { terminalIds: ids, activeTerminalId: ids[0] },
    };
    let renderer;
    await act(async () => {
      renderer = create(React.createElement(bundle.TerminalView, { host, session }), {
        createNodeMock: nodeMock,
      });
    });
    for (let attempt = 0; attempt < 5; attempt++)
      await act(async () => {
        await new Promise((resolve) => setImmediate(resolve));
      });
    const unmount = () =>
      act(async () => {
        renderer.unmount();
      });
    try {
      const root = renderer.root;
      const section = root.find((node) => node.type === "section");
      const body = root.find((node) => node.type === "div" && node.props["data-t3-terminal-body"]);
      const list = root.find(
        (node) => node.type === "ul" && node.props["aria-label"] === "Terminal sessions",
      );
      // What stacks above the body in the panel's column, in order.
      const column = section.children.filter((child) => typeof child !== "string");
      const chromeAbove = column
        .slice(0, column.indexOf(body))
        .map((child) => `${child.type}:${child.props["aria-label"] ?? child.props.role ?? ""}`);
      const within = (ancestor, node) =>
        ancestor.findAll((candidate) => candidate === node).length > 0;
      const aboveBody = (node) =>
        column.slice(0, column.indexOf(body)).some((child) => within(child, node));
      return {
        ids,
        aboveBody,
        body,
        list,
        chromeAbove,
        within,
        panes: root.find((node) => node.props["aria-label"] === "Terminal panes"),
        unmount,
      };
    } catch (error) {
      await unmount();
      throw error;
    }
  }

  NodeTest.test("many sessions list beside the panes and never take their height", async () => {
    const two = await renderSessions(2);
    const ten = await renderSessions(10).catch(async (error) => {
      await two.unmount();
      throw error;
    });
    try {
      // Like the native drawer, the selector sits beside the panes in the
      // body, so ten sessions stack no more above the panes than two do.
      NodeAssert.deepEqual(ten.chromeAbove, two.chromeAbove);
      NodeAssert.ok(!ten.aboveBody(ten.list));
      NodeAssert.ok(ten.within(ten.body, ten.list) && ten.within(ten.body, ten.panes));
      // Like native, rows are selectable labels only; the session actions
      // live once in the sidebar header and act on the active session.
      const rows = ten.list.findAll(
        (node) => node.type === "li" && node.props["data-t3-terminal-session"],
      );
      NodeAssert.equal(rows.length, ten.ids.length);
      for (const row of rows)
        NodeAssert.equal(row.findAll((node) => node.type === "button").length, 1);
      const sidebar = ten.body.find(
        (node) => node.type === "aside" && node.props["aria-label"] === "Terminal session list",
      );
      const actions = sidebar.find(
        (node) => node.props.role === "toolbar" && node.props["aria-label"] === "Session actions",
      );
      NodeAssert.ok(!ten.within(ten.list, actions));
      const restart = actions.find(
        (node) => node.type === "button" && node.props["aria-label"] === "Restart many1",
      );
      await act(async () => {
        restart.props.onClick();
      });
      NodeAssert.ok(
        actions.findAll(
          (node) => node.type === "button" && node.props["aria-label"] === "Confirm restart many1",
        ).length === 1,
        "the header asks to confirm restarting the active session",
      );
      // Native's fixed 144px selector, so the terminal keeps the width; the
      // list scrolls inside the body's height; the body keeps a floor.
      NodeAssert.equal(sidebar.props.style.width, 144);
      NodeAssert.ok(ten.panes.parent.props.style.minWidth >= 160);
      NodeAssert.equal(ten.list.props.style.overflowY, "auto");
      NodeAssert.ok(ten.body.props.style.minHeight >= 120);
    } finally {
      await two.unmount();
      await ten.unmount();
    }
  });

  NodeTest.test(
    "a single session keeps its row above the panes, as native has no sidebar",
    async () => {
      const one = await renderSessions(1);
      try {
        NodeAssert.ok(one.aboveBody(one.list));
        NodeAssert.ok(!one.within(one.body, one.list));
      } finally {
        await one.unmount();
      }
    },
  );
});

NodeTest.describe("exit UX (Terminal 29)", () => {
  const drain = () => new Promise((resolve) => setImmediate(resolve));
  const stubSurfaces = () => globalThis.__T3_TERMINAL_SURFACE_STUB__.surfaces;
  const assetHost = {
    readAsset: async (path) => ({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: path.endsWith(".woff2")
        ? "font/woff2"
        : path.endsWith(".txt")
          ? "text/plain"
          : "application/wasm",
      sha256: "0".repeat(64),
    }),
  };
  const outputSnapshot = (terminalId, streamEpoch, status, contents = "$ ") => ({
    streamId: `${streamEpoch}-${status}`,
    sequence: 1,
    value: {
      terminalId,
      streamEpoch,
      kind: "snapshot",
      status,
      contents,
      retainedByteLength: contents.length,
      truncated: false,
      clearGeneration: 0,
      contentsUnitStart: 0,
      boundarySequence: 1,
    },
  });
  /** Script marker: the transport drops here (a host without resumption throws). */
  const TRANSPORT_DROP = Symbol("transport drop");
  const outputExit = (terminalId, streamEpoch, exitCode) => ({
    streamId: `${streamEpoch}-running`,
    sequence: 2,
    value: { terminalId, streamEpoch, kind: "exit", sequence: 2, exitCode, exitSignal: null },
  });

  /**
   * Renders one session. Each output-events subscription plays the next
   * script: its frames, then (unless it ends the stream as the server does
   * after an exit or an ended snapshot) it stays open until aborted.
   */
  async function renderSession({
    terminalId,
    listed,
    scripts,
    invoke = async () => ({}),
    textFallback = false,
    resumable = false,
  }) {
    const invokes = [];
    let outputSubscriptions = 0;
    // Later session-list snapshots, pushed by `relist`.
    const relisted = [];
    let wakeList = () => {};
    const host = {
      // Without readAsset the view renders the plain-text fallback.
      ...(textFallback ? {} : assetHost),
      invokeApi: async (request) => {
        invokes.push({ id: request.id, method: request.method, input: request.input });
        if (request.id === "t3.ui/theme" && request.method === "getTokens")
          return { tokens: {}, cssVars: {} };
        if (request.id === "t3.terminal/control") return invoke(request);
        return { commandSetToken: "token", results: [] };
      },
      subscribeApi: (request, signal) => ({
        async *[Symbol.asyncIterator]() {
          if (request.id === "t3.terminal/sessions" && request.name === "list") {
            yield { value: { kind: "snapshot", terminals: [listed] } };
            while (!signal.aborted) {
              const row = relisted.shift();
              if (row) yield { value: { kind: "snapshot", terminals: [row] } };
              else
                await new Promise((resolve) => {
                  wakeList = resolve;
                  signal.addEventListener("abort", resolve, { once: true });
                });
            }
            return;
          }
          if (request.id === "t3.terminal/output-events") {
            const script = scripts[outputSubscriptions++] ?? { frames: [], ends: false };
            for (const next of script.frames) {
              if (next === TRANSPORT_DROP) throw new Error("socket closed");
              if (typeof next === "function") await next();
              else yield next;
            }
            if (script.ends) return;
          }
          await new Promise((resolve) =>
            signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }),
          );
        },
      }),
      // Stands in for the host's session-following transport: a drop
      // suspends the iterable and the next session plays the next script.
      ...(resumable
        ? {
            resumableStreams: {
              version: 1,
              subscribeApi: (request, signal, options) => ({
                async *[Symbol.asyncIterator]() {
                  // The session list resumes too; these scripts never drop it.
                  if (request.id === "t3.terminal/sessions") {
                    yield* host.subscribeApi(request, signal);
                    return;
                  }
                  NodeAssert.equal(request.id, "t3.terminal/output-events");
                  session: for (;;) {
                    const script = scripts[outputSubscriptions++] ?? { frames: [], ends: false };
                    for (const next of script.frames) {
                      if (next === TRANSPORT_DROP) {
                        options?.onSuspended?.();
                        continue session;
                      }
                      if (typeof next === "function") await next();
                      else yield next;
                    }
                    if (script.ends) return;
                    break;
                  }
                  await new Promise((resolve) =>
                    signal.aborted
                      ? resolve()
                      : signal.addEventListener("abort", resolve, { once: true }),
                  );
                },
              }),
            },
          }
        : {}),
    };
    const session = {
      signal: new AbortController().signal,
      context: {
        resource: { threadId: "t", environmentId: "e" },
        workspaceRevision: JSON.stringify(["/ws/root", null]),
      },
      visible: true,
      save() {},
      onVisibility: () => () => {},
      bindCommands: () => () => {},
      restoreState: { terminalIds: [terminalId], activeTerminalId: terminalId },
    };
    stubSurfaces().length = 0;
    let renderer;
    await act(async () => {
      renderer = create(React.createElement(bundle.TerminalView, { host, session }), {
        createNodeMock: nodeMock,
      });
    });
    const settle = () =>
      act(async () => {
        for (let index = 0; index < 8; index++) await drain();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await drain();
      });
    for (let attempt = 0; stubSurfaces().length === 0 && attempt < 20; attempt++) await settle();
    return {
      renderer,
      invokes,
      settle,
      relist: async (row) => {
        relisted.push(row);
        wakeList();
        await settle();
      },
      fallbackText: () =>
        renderer.root
          .find((node) => node.type === "pre" && node.props["aria-label"] === "Terminal output")
          .children.join(""),
      outputSubscriptions: () => outputSubscriptions,
      closes: () =>
        invokes.filter((entry) => entry.id === "t3.terminal/control" && entry.method === "close"),
      rows: () =>
        renderer.root
          .find((node) => node.type === "ul" && node.props["aria-label"] === "Terminal sessions")
          .findAll((node) => node.type === "li" && node.props["data-t3-terminal-session"]).length,
      unmount: () =>
        act(async () => {
          renderer.unmount();
        }),
    };
  }

  const clickStart = async (view, terminalId) => {
    const start = view.renderer.root.find(
      (node) => node.type === "button" && node.props["aria-label"] === `Start ${terminalId}`,
    );
    await act(async () => {
      start.props.onClick();
    });
    await view.settle();
  };
  const gate = () => {
    let open;
    const wait = new Promise((resolve) => (open = resolve));
    return { wait: () => wait, open: () => open() };
  };
  const startSucceeds = async (request) =>
    request.method === "attach" ? sessionMetadata(request.input.terminalId) : {};
  const paneOutput = (view, textFallback) =>
    textFallback ? view.fallbackText() : stubSurfaces()[0].writes.join("");

  /**
   * Output reattach, ported from the native drawer's durable attach
   * subscription: an ended stream resubscribes once per new session edge
   * (non-running → running), latched while the old stream drains, and never
   * replaces a healthy stream. `added` counts subscriptions after mount.
   */
  const outputCases = [
    {
      name: "delayed Retry: Start after the failed stream ended",
      listed: "error",
      invoke: startSucceeds,
      scripts: (id) => [
        { frames: [outputSnapshot(id, "epoch-1", "error", "")], ends: true },
        { frames: [outputSnapshot(id, "epoch-2", "running", "$ ready")], ends: false },
      ],
      drive: (view, id) => clickStart(view, id),
      added: 1,
      output: "$ ready",
    },
    {
      name: "Start before the old stream ends",
      listed: "error",
      invoke: startSucceeds,
      setup: () => ({ oldEnd: gate() }),
      scripts: (id, { oldEnd }) => [
        { frames: [outputSnapshot(id, "epoch-1", "error", ""), oldEnd.wait], ends: true },
        { frames: [outputSnapshot(id, "epoch-2", "running", "$ ready")], ends: false },
      ],
      drive: async (view, id, { oldEnd }, before) => {
        await clickStart(view, id);
        NodeAssert.equal(view.outputSubscriptions(), before, "the old stream is still draining");
        oldEnd.open();
        await view.settle();
      },
      added: 1,
      output: "$ ready",
    },
    {
      name: "transport drop, then running",
      listed: "running",
      setup: () => ({ drop: gate() }),
      scripts: (id, { drop }) => [
        {
          frames: [
            outputSnapshot(id, "epoch-1", "running", "$ old"),
            drop.wait,
            () => {
              throw new Error("socket closed");
            },
          ],
          ends: true,
        },
        { frames: [outputSnapshot(id, "epoch-2", "running", "$ recovered")], ends: false },
      ],
      drive: async (view, id, { drop }) => {
        drop.open();
        await view.settle();
        await view.relist({ ...sessionMetadata(id), status: "starting" });
        await view.relist(sessionMetadata(id));
      },
      added: 1,
      output: "$ recovered",
    },
    {
      name: "stale running row, then a later Start",
      listed: "running",
      // The server keeps returning the failed process until Start runs a new one.
      setup: () => ({ started: false }),
      invoke: (request, state) => {
        if (request.method === "attach") state.started = true;
        return startSucceeds(request);
      },
      scripts: (id, state) =>
        Array.from({ length: 6 }, () => ({
          get frames() {
            return [
              state.started
                ? outputSnapshot(id, "epoch-2", "running", "$ restarted")
                : outputSnapshot(id, "epoch-1", "error", ""),
            ];
          },
          get ends() {
            return !state.started;
          },
        })),
      drive: async (view, id, _state, before) => {
        NodeAssert.equal(view.outputSubscriptions(), before, "a stale row never resubscribes");
        await view.relist({ ...sessionMetadata(id), status: "error" });
        await clickStart(view, id);
      },
      added: 1,
      output: "$ restarted",
    },
    {
      name: "exit closes the session",
      listed: "running",
      setup: () => ({ exit: gate() }),
      scripts: (id, { exit }) => [
        {
          frames: [
            outputSnapshot(id, "epoch-1", "running"),
            exit.wait,
            outputExit(id, "epoch-1", 3),
          ],
          ends: true,
        },
        // The resubscription reads the server's current state: still exited.
        { frames: [outputSnapshot(id, "epoch-1", "exited")], ends: true },
      ],
      drive: async (view, _id, { exit }) => {
        exit.open();
        await view.settle();
      },
      added: 1,
      closes: 1,
      rows: 0,
    },
    {
      name: "replacement process is kept, then its own exit closes",
      listed: "running",
      setup: () => ({ exit: gate(), secondExit: gate() }),
      scripts: (id, { exit, secondExit }) => [
        {
          frames: [
            outputSnapshot(id, "epoch-1", "running"),
            exit.wait,
            outputExit(id, "epoch-1", 0),
          ],
          ends: true,
        },
        {
          frames: [
            outputSnapshot(id, "epoch-2", "running", "$ new"),
            secondExit.wait,
            outputExit(id, "epoch-2", 7),
          ],
          ends: true,
        },
        { frames: [outputSnapshot(id, "epoch-2", "exited")], ends: true },
      ],
      drive: async (view, _id, { exit, secondExit }, _before, textFallback) => {
        exit.open();
        await view.settle();
        await view.settle();
        NodeAssert.deepEqual(view.closes(), []);
        NodeAssert.equal(view.rows(), 1);
        NodeAssert.ok(paneOutput(view, textFallback).includes("$ new"), "the replacement renders");
        secondExit.open();
        await view.settle();
      },
      added: 2,
      closes: 1,
      rows: 0,
    },
    {
      name: "healthy stream keeps its subscription across status flips",
      listed: "running",
      scripts: (id) => [
        { frames: [outputSnapshot(id, "epoch-1", "running", "$ one")], ends: false },
        { frames: [outputSnapshot(id, "epoch-1", "running", "$ one")], ends: false },
      ],
      drive: async (view, id) => {
        await view.relist({ ...sessionMetadata(id), status: "starting" });
        await view.relist(sessionMetadata(id));
      },
      added: 0,
      output: "$ one",
    },
  ];

  // A resuming host must not change process Start/exit/replacement handling:
  // the same table runs against both host kinds.
  for (const [index, testCase] of outputCases.entries())
    for (const textFallback of [false, true])
      for (const resumable of [false, true])
        NodeTest.test(
          `output reattach (${textFallback ? "fallback" : "VT"}${resumable ? ", resuming host" : ""}): ${testCase.name}`,
          async () => {
            const id = `reattach${index}${textFallback ? "f" : "v"}${resumable ? "r" : ""}`;
            const state = testCase.setup?.() ?? {};
            const scripts = testCase.scripts(id, state);
            const view = await renderSession({
              terminalId: id,
              listed: { ...sessionMetadata(id), status: testCase.listed },
              textFallback,
              resumable,
              ...(testCase.invoke ? { invoke: (request) => testCase.invoke(request, state) } : {}),
              // The fallback first mounts a loading VT pane whose brief
              // subscription sees the same initial snapshot.
              scripts: textFallback
                ? [{ frames: [scripts[0].frames[0]], ends: false }, ...scripts]
                : scripts,
            });
            try {
              await view.settle();
              const before = view.outputSubscriptions();
              await testCase.drive(view, id, state, before, textFallback);
              if (testCase.output !== undefined)
                NodeAssert.ok(
                  paneOutput(view, textFallback).includes(testCase.output),
                  `renders ${testCase.output}`,
                );
              NodeAssert.equal(view.closes().length, testCase.closes ?? 0, "close calls");
              if (testCase.rows !== undefined) NodeAssert.equal(view.rows(), testCase.rows);
              NodeAssert.equal(
                view.outputSubscriptions() - before,
                testCase.added,
                "subscriptions added",
              );
            } finally {
              for (const value of Object.values(state)) value?.open?.();
              await view.unmount();
            }
          },
        );

  /**
   * A transport drop while the session metadata stays running. Start first
   * consumes the running edge, so no status edge fires afterwards and only
   * the host's session-following resumption can recover output. The resumed
   * stream restarts at sequence 1 with a snapshot of the same process
   * (unchanged epoch); a chunk group torn by the drop is discarded.
   */
  const partialChunk = (terminalId, streamEpoch) => ({
    streamId: `${streamEpoch}-running`,
    sequence: 2,
    value: {
      terminalId,
      streamEpoch,
      kind: "output",
      sequence: 2,
      chunkIndex: 0,
      chunkCount: 2,
      data: "$ torn",
    },
  });
  for (const torn of [false, true])
    for (const textFallback of [false, true])
      NodeTest.test(
        `host resumption (${textFallback ? "fallback" : "VT"}): transport drop while running recovers output${torn ? " past a torn chunk group" : ""}`,
        async () => {
          const id = `resume${torn ? "t" : ""}${textFallback ? "f" : "v"}`;
          const drop = gate();
          const failed = { frames: [outputSnapshot(id, "epoch-1", "error", "")], ends: true };
          const view = await renderSession({
            terminalId: id,
            listed: { ...sessionMetadata(id), status: "error" },
            textFallback,
            resumable: true,
            invoke: startSucceeds,
            scripts: [
              // The fallback first mounts a loading VT pane.
              ...(textFallback ? [failed] : []),
              failed,
              {
                frames: [
                  outputSnapshot(id, "epoch-2", "running", "$ before drop"),
                  ...(torn ? [partialChunk(id, "epoch-2")] : []),
                  drop.wait,
                  TRANSPORT_DROP,
                ],
                ends: true,
              },
              {
                frames: [outputSnapshot(id, "epoch-2", "running", "$ before drop\r\n$ recovered")],
                ends: false,
              },
            ],
          });
          try {
            await clickStart(view, id);
            const before = view.outputSubscriptions();
            NodeAssert.ok(paneOutput(view, textFallback).includes("$ before drop"), "live first");
            drop.open();
            await view.settle();
            await view.settle();
            NodeAssert.equal(view.outputSubscriptions() - before, 1, "one resumed subscription");
            NodeAssert.ok(
              paneOutput(view, textFallback).includes("$ recovered"),
              "output recovers without a metadata edge",
            );
            if (textFallback) NodeAssert.ok(!paneOutput(view, true).includes("$ torn"));
            const statuses = view.renderer.root
              .findAll(
                (node) => node.type === "output" && node.props["aria-label"] === "Output status",
              )
              .map((node) => node.children.join(""));
            NodeAssert.ok(
              statuses.every(
                (status) => !/closed|discontinuous|incomplete|unavailable/i.test(status),
              ),
              `no error status: ${JSON.stringify(statuses)}`,
            );
            NodeAssert.equal(view.closes().length, 0, "close calls");
          } finally {
            drop.open();
            await view.unmount();
          }
        },
      );

  for (const textFallback of [false, true])
    NodeTest.test(
      `host resumption (${textFallback ? "fallback" : "VT"}): a dropped transport reads Reconnecting… until the resumed snapshot`,
      async () => {
        const id = `reconnect${textFallback ? "f" : "v"}`;
        const drop = gate();
        const resume = gate();
        const failed = { frames: [outputSnapshot(id, "epoch-1", "error", "")], ends: true };
        const view = await renderSession({
          terminalId: id,
          listed: { ...sessionMetadata(id), status: "error" },
          textFallback,
          resumable: true,
          invoke: startSucceeds,
          scripts: [
            ...(textFallback ? [failed] : []),
            failed,
            {
              frames: [outputSnapshot(id, "epoch-2", "running", "$ "), drop.wait, TRANSPORT_DROP],
              ends: true,
            },
            {
              frames: [resume.wait, outputSnapshot(id, "epoch-2", "running", "$ back")],
              ends: false,
            },
          ],
        });
        const status = () =>
          view.renderer.root
            .findAll(
              (node) => node.type === "output" && node.props["aria-label"] === "Output status",
            )
            .map((node) => node.children.join(""))
            .join(" | ");
        try {
          await clickStart(view, id);
          NodeAssert.match(status(), /Watching live output/);
          drop.open();
          await view.settle();
          NodeAssert.equal(status(), `${id}: Reconnecting…`);
          resume.open();
          await view.settle();
          await view.settle();
          NodeAssert.match(status(), /Watching live output/);
          NodeAssert.ok(paneOutput(view, textFallback).includes("$ back"));
        } finally {
          drop.open();
          resume.open();
          await view.unmount();
        }
      },
    );
});

NodeTest.describe("toolbar hover help", () => {
  /** A host tooltip that records what each control would show on hover. */
  function RecordingTooltip({ label, children }) {
    return children;
  }
  const shortcuts = {
    "terminal.new": "⌘T",
    "terminal.split": "⌘D",
    "terminal.splitVertical": "⇧⌘D",
    "terminal.close": "⌘W",
  };

  async function renderToolbar(restoreState, metadata = {}) {
    const ids = restoreState.terminalIds;
    const host = {
      React,
      tooltip: { version: 1, Tooltip: RecordingTooltip },
      keybindings: { terminalFocusShortcutLabel: (command) => shortcuts[command] ?? null },
      readAsset: () => new Promise(() => {}),
      invokeApi: async () => ({ tokens: {}, cssVars: {} }),
      subscribeApi: (request, signal) => ({
        async *[Symbol.asyncIterator]() {
          if (request.id === "t3.terminal/sessions" && request.name === "list")
            yield {
              value: {
                kind: "snapshot",
                terminals: ids.map((id) => ({ ...sessionMetadata(id), ...metadata[id] })),
              },
            };
          await new Promise((resolve) =>
            signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }),
          );
        },
      }),
    };
    const session = {
      signal: new AbortController().signal,
      context: { resource: { threadId: "t", environmentId: "e" } },
      visible: true,
      save() {},
      onVisibility: () => () => {},
      bindCommands: () => () => {},
      restoreState,
    };
    let renderer;
    await act(async () => {
      renderer = create(React.createElement(bundle.TerminalView, { host, session }), {
        createNodeMock: nodeMock,
      });
    });
    for (let attempt = 0; attempt < 5; attempt++)
      await act(async () => {
        await new Promise((resolve) => setImmediate(resolve));
      });
    // Hover help per control, keyed by the control's own name.
    const help = new Map(
      renderer.root.findAllByType(RecordingTooltip).map((tooltip) => {
        const button = tooltip.findByType("button");
        const name =
          button.props["aria-label"] ??
          button.children.filter((child) => typeof child === "string").join("");
        return [name, tooltip.props];
      }),
    );
    // Each session button's accessible name: aria-label, else its text.
    const sessionNames = Object.fromEntries(
      renderer.root
        .findAll((node) => node.type === "li" && node.props["data-t3-terminal-session"])
        .map((row) => {
          const button = row.findByType("button");
          return [
            row.props["data-t3-terminal-session"],
            button.props["aria-label"] ??
              button.children.filter((child) => typeof child === "string").join(""),
          ];
        }),
    );
    return { help, sessionNames, unmount: () => act(async () => renderer.unmount()) };
  }

  NodeTest.test("each toolbar and session action names itself and its shortcut", async () => {
    const view = await renderToolbar({ terminalIds: ["a", "b"], activeTerminalId: "a" });
    try {
      const labels = Object.fromEntries([...view.help].map(([name, props]) => [name, props.label]));
      NodeAssert.deepEqual(labels, {
        "New terminal": "New Terminal (⌘T)",
        "Split horizontally": "Split Terminal Horizontally (⌘D)",
        "Split vertically": "Split Terminal Vertically (⇧⌘D)",
        "Clear a": "Clear history",
        "Restart a": "Restart",
        // The toolbar closes whichever terminal is active, so it names the
        // action as native's drawer toolbar does, not the tab.
        "Close Terminal (⌘W)": "Close Terminal (⌘W)",
        // Session rows show their status, or their label while running.
        a: "a",
        b: "b",
      });
      // Native's action popovers open below their trigger.
      for (const props of view.help.values()) NodeAssert.equal(props.side, "bottom");
    } finally {
      await view.unmount();
    }
  });

  NodeTest.test("a session button announces its status, not only its hover help", async () => {
    // The status tooltip is visual; screen readers navigating an inactive
    // exited session must still hear why it is not running.
    const view = await renderToolbar(
      { terminalIds: ["a", "b"], activeTerminalId: "a" },
      { b: { status: "exited", exitCode: 2 } },
    );
    try {
      NodeAssert.equal(view.sessionNames.a, "a");
      NodeAssert.match(view.sessionNames.b, /^b — .*exited \(code 2\)/);
    } finally {
      await view.unmount();
    }
  });

  NodeTest.test("at the group limit the disabled splits still explain why", async () => {
    const ids = ["a", "b", "c", "d"];
    const view = await renderToolbar({
      terminalIds: ids,
      activeTerminalId: "a",
      terminalGroups: [{ id: "g", terminalIds: ids }],
      activeTerminalGroupId: "g",
    });
    try {
      const horizontal = view.help.get("Split horizontally (max 4 per group)");
      const vertical = view.help.get("Split vertically (max 4 per group)");
      NodeAssert.ok(horizontal && vertical, "both splits carry hover help at the limit");
      NodeAssert.equal(horizontal.label, "Split Terminal Horizontally (max 4 per group)");
      NodeAssert.equal(vertical.label, "Split Terminal Vertically (max 4 per group)");
      NodeAssert.equal(horizontal.showWhenDisabled, true);
      NodeAssert.equal(vertical.showWhenDisabled, true);
    } finally {
      await view.unmount();
    }
  });
});

NodeTest.test(
  "the session list rides out a transport drop and resumes on the next session",
  async () => {
    const drain = () => new Promise((resolve) => setImmediate(resolve));
    const gate = () => {
      let open;
      const wait = new Promise((resolve) => (open = resolve));
      return { wait, open: () => open() };
    };
    const drop = gate();
    const resume = gate();
    const hang = (signal) =>
      new Promise((resolve) =>
        signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }),
      );
    const snapshot = (ids) => ({
      value: { kind: "snapshot", terminals: ids.map((id) => sessionMetadata(id)) },
    });
    const host = {
      React,
      readAsset: () => new Promise(() => {}),
      invokeApi: async () => ({ tokens: {}, cssVars: {} }),
      // A plain stream dies with the transport, as the web host's does.
      subscribeApi: (request, signal) => ({
        async *[Symbol.asyncIterator]() {
          if (request.id === "t3.terminal/sessions" && request.name === "list") {
            yield snapshot(["a"]);
            await drop.wait;
            throw new Error("All fibers interrupted without error");
          }
          await hang(signal);
        },
      }),
      // The host's session-following transport: a drop suspends the iterable
      // and the next session opens with a fresh snapshot.
      resumableStreams: {
        version: 2,
        subscribeApi: (request, signal, options) => ({
          async *[Symbol.asyncIterator]() {
            if (request.id === "t3.terminal/sessions" && request.name === "list") {
              yield snapshot(["a"]);
              await drop.wait;
              options?.onSuspended?.();
              await resume.wait;
              yield snapshot(["a", "b"]);
            }
            await hang(signal);
          },
        }),
      },
    };
    const session = {
      signal: new AbortController().signal,
      context: { resource: { threadId: "t", environmentId: "e" } },
      visible: true,
      save() {},
      onVisibility: () => () => {},
      bindCommands: () => () => {},
      restoreState: { terminalIds: ["a"], activeTerminalId: "a" },
    };
    let renderer;
    await act(async () => {
      renderer = create(React.createElement(bundle.TerminalView, { host, session }), {
        createNodeMock: nodeMock,
      });
    });
    const settle = () =>
      act(async () => {
        for (let index = 0; index < 8; index++) await drain();
      });
    const text = () => JSON.stringify(renderer.toJSON());
    const newTerminal = () =>
      renderer.root.find(
        (node) => node.type === "button" && node.children.includes("New terminal"),
      );
    const rows = () =>
      renderer.root
        .findAll((node) => node.type === "li" && node.props["data-t3-terminal-session"])
        .map((row) => row.props["data-t3-terminal-session"]);
    try {
      await settle();
      NodeAssert.equal(newTerminal().props.disabled, false);
      drop.open();
      await settle();
      NodeAssert.doesNotMatch(text(), /Session list disconnected|All fibers interrupted/);
      NodeAssert.equal(newTerminal().props.disabled, true);
      resume.open();
      await settle();
      NodeAssert.doesNotMatch(text(), /Session list disconnected|All fibers interrupted/);
      NodeAssert.equal(newTerminal().props.disabled, false);
      NodeAssert.deepEqual(rows(), ["a", "b"]);
    } finally {
      drop.open();
      resume.open();
      await act(async () => renderer.unmount());
    }
  },
);

NodeTest.test(
  "a version 1 host lists sessions on the plain stream, and New and Split work",
  async () => {
    const drain = () => new Promise((resolve) => setImmediate(resolve));
    const hang = (signal) =>
      new Promise((resolve) =>
        signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }),
      );
    const plainLists = [];
    const invokes = [];
    const host = {
      React,
      readAsset: () => new Promise(() => {}),
      invokeApi: async (request) => {
        invokes.push(request);
        return request.id === "t3.terminal/control" && request.method === "open"
          ? sessionMetadata(request.input.terminalId)
          : { tokens: {}, cssVars: {} };
      },
      subscribeApi: (request, signal) => ({
        async *[Symbol.asyncIterator]() {
          if (request.id === "t3.terminal/sessions" && request.name === "list") {
            plainLists.push(request);
            yield { value: { kind: "snapshot", terminals: [sessionMetadata("a")] } };
          }
          await hang(signal);
        },
      }),
      // The web host as it shipped at version 1: output events only.
      resumableStreams: {
        version: 1,
        subscribeApi: (request, signal) => {
          if (`${request.id}#${request.name}` !== "t3.terminal/output-events#subscribe")
            throw new Error(`${request.id}#${request.name} is not resumable`);
          return {
            async *[Symbol.asyncIterator]() {
              await hang(signal);
            },
          };
        },
      },
    };
    const session = {
      signal: new AbortController().signal,
      context: {
        resource: { threadId: "t", environmentId: "e" },
        workspaceRevision: JSON.stringify(["/private/tmp/t3-terminal-v1-host", null]),
      },
      visible: true,
      save() {},
      onVisibility: () => () => {},
      bindCommands: () => () => {},
      restoreState: { terminalIds: ["a"], activeTerminalId: "a" },
    };
    let renderer;
    await act(async () => {
      renderer = create(React.createElement(bundle.TerminalView, { host, session }), {
        createNodeMock: nodeMock,
      });
    });
    const settle = () =>
      act(async () => {
        for (let index = 0; index < 8; index++) await drain();
      });
    const button = (label) =>
      renderer.root.find((node) => node.type === "button" && node.children.includes(label));
    const opens = () =>
      invokes.filter((entry) => entry.id === "t3.terminal/control" && entry.method === "open");
    try {
      await settle();
      NodeAssert.equal(plainLists.length, 1);
      NodeAssert.doesNotMatch(
        JSON.stringify(renderer.toJSON()),
        /Session list disconnected|not resumable/,
      );
      for (const label of ["New terminal", "Split horizontally", "Split vertically"])
        NodeAssert.equal(button(label).props.disabled, false, label);
      await act(async () => button("New terminal").props.onClick());
      await settle();
      NodeAssert.equal(opens().length, 1);
      await act(async () => button("Split horizontally").props.onClick());
      await settle();
      NodeAssert.equal(opens().length, 2);
    } finally {
      await act(async () => renderer.unmount());
    }
  },
);

NodeTest.describe(
  "a restart's missing observation retries a failed automatic start (Terminal 36)",
  () => {
    // A failed start leaves the shown pane closed; the next missing snapshot
    // re-arms it without changing its status or the list's stream, so the view
    // must still schedule the one retry. A version 1 host never reports the
    // gap; a later host reports it in the same React update as the snapshot.
    for (const suspends of [false, true]) {
      const name = `the view starts the pane again ${suspends ? "with" : "without"} onSuspended`;
      NodeTest.test(name, async () => {
        const drain = () => new Promise((resolve) => setImmediate(resolve));
        const hang = (signal) =>
          new Promise((resolve) =>
            signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }),
          );
        let restarted;
        const restart = new Promise((resolve) => (restarted = resolve));
        let attachFails = true;
        const attaches = [];
        const host = {
          React,
          readAsset: () => new Promise(() => {}),
          invokeApi: async (request) => {
            if (request.id !== "t3.terminal/control") return { tokens: {}, cssVars: {} };
            if (request.method !== "attach") return {};
            attaches.push(request.input);
            if (attachFails) throw new Error("Environment is not connected");
            return sessionMetadata(request.input.terminalId);
          },
          subscribeApi: (_request, signal) => ({
            async *[Symbol.asyncIterator]() {
              await hang(signal);
            },
          }),
          resumableStreams: {
            version: 2,
            subscribeApi: (request, signal, options) => ({
              async *[Symbol.asyncIterator]() {
                if (request.id === "t3.terminal/sessions" && request.name === "list") {
                  yield { value: { kind: "snapshot", terminals: [] } };
                  await restart;
                  if (suspends) options?.onSuspended?.();
                  yield { value: { kind: "snapshot", terminals: [] } };
                }
                await hang(signal);
              },
            }),
          },
        };
        const session = {
          signal: new AbortController().signal,
          context: {
            resource: { threadId: "t", environmentId: "e" },
            workspaceRevision: JSON.stringify(["/ws/root", null]),
          },
          visible: true,
          save() {},
          onVisibility: () => () => {},
          bindCommands: () => () => {},
          restoreState: { terminalIds: ["term-1"], activeTerminalId: "term-1" },
        };
        let renderer;
        await act(async () => {
          renderer = create(React.createElement(bundle.TerminalView, { host, session }), {
            createNodeMock: nodeMock,
          });
        });
        const settle = () =>
          act(async () => {
            for (let index = 0; index < 8; index++) await drain();
          });
        try {
          await settle();
          NodeAssert.equal(attaches.length, 1);
          NodeAssert.equal(attaches[0].restartIfNotRunning, undefined);
          attachFails = false;
          await act(async () => {
            restarted();
            for (let index = 0; index < 8; index++) await drain();
          });
          await settle();
          NodeAssert.equal(attaches.length, 2);
          NodeAssert.equal(attaches[1].restartIfNotRunning, undefined);
          await settle();
          NodeAssert.equal(attaches.length, 2, "one retry per missing observation");
        } finally {
          await act(async () => renderer.unmount());
        }
      });
    }
  },
);

NodeTest.test("saved Close suppression survives component reload (web-r7 S1)", async () => {
  const savedStates = [];
  const invokes = [];
  const commits = [];
  let closed = false;
  const host = {
    invokeApi: async (request) => {
      invokes.push(request);
      if (request.id === "t3.terminal/control" && request.method === "close") {
        closed = true;
        return {};
      }
      return { tokens: {}, cssVars: {} };
    },
    subscribeApi: (request, signal) => ({
      async *[Symbol.asyncIterator]() {
        if (request.id === "t3.terminal/sessions")
          yield {
            value: {
              kind: "snapshot",
              terminals: [
                sessionMetadata("term-1"),
                ...(closed
                  ? []
                  : [{ ...sessionMetadata("term-6"), status: "exited", exitCode: 0 }]),
              ],
            },
          };
        await new Promise((resolve) =>
          signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }),
        );
      },
    }),
  };
  const session = {
    signal: new AbortController().signal,
    context: {
      resource: { threadId: "t", environmentId: "e" },
      workspaceRevision: JSON.stringify(["/ws/root", null]),
    },
    visible: true,
    save: (state) => savedStates.push(JSON.parse(JSON.stringify(state))),
    onVisibility: () => () => {},
    bindCommands: () => () => {},
    restoreState: {
      terminalIds: ["term-1", "term-6"],
      activeTerminalId: "term-1",
      suppressedTerminalIds: ["term-6"],
    },
  };
  let renderer;
  const onRender = () => {
    if (renderer) commits.push(JSON.stringify(renderer.toJSON()));
  };
  for (let reload = 0; reload < 2; reload++) {
    NodeAssert.equal(bundle.restoreState(session.restoreState), true);
    NodeAssert.equal(
      bundle.restoreState({ ...session.restoreState, suppressedTerminalIds: [6] }),
      false,
    );
    await act(async () => {
      renderer = create(
        React.createElement(
          React.Profiler,
          { id: "terminal-close-reload", onRender },
          React.createElement(bundle.TerminalView, { host, session }),
        ),
        { createNodeMock: nodeMock },
      );
    });
    try {
      NodeAssert.ok(savedStates.length > 0);
      NodeAssert.deepEqual(savedStates.at(-1).terminalIds, ["term-1"]);
      NodeAssert.deepEqual(savedStates.at(-1).suppressedTerminalIds, []);
      for (const commit of commits)
        NodeAssert.doesNotMatch(commit, /"data-t3-terminal-session":"term-6"/);
      session.restoreState = savedStates.at(-1);
    } finally {
      await act(async () => renderer.unmount());
    }
  }
  NodeAssert.deepEqual(
    invokes
      .filter((request) => request.id === "t3.terminal/control")
      .map(({ method, input }) => [method, input]),
    [["close", { terminalId: "term-6", deleteHistory: true }]],
  );
});

NodeTest.describe("a re-attaching pane hides the dead session's attach error (flash)", () => {
  // After a backend restart the resumed output stream can reject with the
  // server's "Unknown terminal thread" before the automatic start lands.
  // Native shows its connecting state there; only a failed start is an error.
  const UNKNOWN = "Unknown terminal thread: t, terminal: term-1";
  for (const textFallback of [false, true]) {
    for (const outcome of [
      "running",
      "start-failed",
      "still-unknown",
      "output-failed",
      "ack-error-r2",
      "ack-error-snapshot",
      "ack-exited-r2",
      "empty-output-r2",
      "ack-error-empty-r2",
      "ack-exited-empty-r2",
      "ack-error-hang-r2",
      "ack-exited-hang-r2",
      "no-workspace",
    ]) {
      NodeTest.test(
        `${textFallback ? "text fallback" : "surface"}: recovery never commits raw unknown-thread text (${outcome}, desktop-r7 row 1)`,
        async () => {
          let rejectOutput;
          const outputFailure = new Promise((_, reject) => (rejectOutput = reject));
          let finishAttach;
          const attach = new Promise((resolve) => (finishAttach = resolve));
          let attempts = 0;
          let subscriptions = 0;
          let outage = false;
          let recovered = false;
          const hang = (signal) =>
            new Promise((resolve) =>
              signal.aborted
                ? resolve()
                : signal.addEventListener("abort", resolve, { once: true }),
            );
          const host = {
            ...(textFallback
              ? {}
              : {
                  readAsset: async (path) => ({
                    bytes: new Uint8Array([1, 2, 3]),
                    mediaType: path.endsWith(".woff2")
                      ? "font/woff2"
                      : path.endsWith(".txt")
                        ? "text/plain"
                        : "application/wasm",
                    sha256: "0".repeat(64),
                  }),
                }),
            invokeApi: async (request) => {
              if (request.id === "t3.ui/theme") return { tokens: {}, cssVars: {} };
              if (request.id !== "t3.terminal/control" || request.method !== "attach") return {};
              attempts += 1;
              await attach;
              if (outcome === "start-failed") throw new Error("spawn failed");
              recovered = true;
              return {
                ...sessionMetadata(request.input.terminalId),
                status: outcome.startsWith("ack-error")
                  ? "error"
                  : outcome.startsWith("ack-exited")
                    ? "exited"
                    : "running",
              };
            },
            subscribeApi: (request, signal) => ({
              async *[Symbol.asyncIterator]() {
                if (request.id === "t3.terminal/sessions")
                  yield { value: { kind: "snapshot", terminals: [sessionMetadata("term-1")] } };
                if (request.id === "t3.terminal/output-events") {
                  subscriptions += 1;
                  if (outage && (!recovered || outcome === "still-unknown"))
                    throw new Error(UNKNOWN);
                  if (outage && outcome === "output-failed")
                    throw new Error("Terminal output permission denied");
                  if (outage && outcome.includes("empty")) return;
                  if (outage && outcome.includes("hang")) {
                    await hang(signal);
                    return;
                  }
                  if (outage && outcome === "ack-error-r2")
                    throw new Error("PTY spawn failed: shell not found");
                  yield {
                    streamId: "recovered",
                    sequence: 1,
                    value: {
                      terminalId: "term-1",
                      streamEpoch: "recovered",
                      kind: "snapshot",
                      status:
                        outage && outcome === "ack-exited-r2"
                          ? "exited"
                          : outage && outcome === "ack-error-snapshot"
                            ? "error"
                            : "running",
                      contents: "$ ",
                      retainedByteLength: 2,
                      truncated: false,
                      clearGeneration: 0,
                      contentsUnitStart: 0,
                      boundarySequence: 1,
                    },
                  };
                  if (!outage) await Promise.race([outputFailure, hang(signal)]);
                }
                await hang(signal);
              },
            }),
          };
          const session = {
            signal: new AbortController().signal,
            context: {
              resource: { threadId: "t", environmentId: "e" },
              ...(outcome === "no-workspace"
                ? {}
                : { workspaceRevision: JSON.stringify(["/ws/root", null]) }),
            },
            visible: true,
            save() {},
            onVisibility: () => () => {},
            bindCommands: () => () => {},
            restoreState: { terminalIds: ["term-1"], activeTerminalId: "term-1" },
          };
          let renderer;
          const commits = [];
          const onRender = () => {
            if (renderer) commits.push(JSON.stringify(renderer.toJSON()));
          };
          await act(async () => {
            renderer = create(
              React.createElement(
                React.Profiler,
                { id: "terminal-recovery", onRender },
                React.createElement(bundle.TerminalView, { host, session }),
              ),
              { createNodeMock: nodeMock },
            );
          });
          const settle = () =>
            act(async () => {
              await new Promise(setImmediate);
            });
          const statusText = () =>
            renderer.root
              .findAll(
                (node) => node.type === "output" && node.props["aria-label"] === "Output status",
              )
              .map((node) => node.children.join(""))
              .join("\n");
          try {
            await settle();
            NodeAssert.ok(subscriptions >= 1);
            await act(async () => {
              outage = true;
              rejectOutput(new Error(UNKNOWN));
            });
            await settle();
            if (outcome === "no-workspace") {
              NodeAssert.equal(attempts, 0);
              NodeAssert.match(statusText(), /Unknown terminal thread/);
              return;
            }
            NodeAssert.ok(commits.length > 0);
            for (const commit of commits)
              NodeAssert.doesNotMatch(commit, /Unknown terminal thread/);
            NodeAssert.equal(attempts, 1);
            NodeAssert.equal(statusText(), "term-1: Connecting…");
            finishAttach();
            await settle();
            if (outcome === "running") {
              NodeAssert.equal(statusText(), "term-1: Watching live output.");
              for (const commit of commits)
                NodeAssert.doesNotMatch(commit, /Unknown terminal thread/);
            } else if (outcome === "output-failed") {
              NodeAssert.match(statusText(), /Terminal output permission denied/);
            } else if (outcome.includes("empty")) {
              NodeAssert.match(statusText(), /Terminal output ended before a snapshot arrived/);
            } else if (outcome === "ack-error-r2") {
              NodeAssert.match(statusText(), /PTY spawn failed: shell not found/);
            } else if (outcome === "ack-error-snapshot") {
              NodeAssert.equal(statusText(), "term-1: Terminal failed to start.");
              NodeAssert.equal(subscriptions, 3);
              for (const commit of commits)
                NodeAssert.doesNotMatch(commit, /Unknown terminal thread/);
            } else if (outcome === "ack-exited-r2") {
              NodeAssert.doesNotMatch(
                JSON.stringify(renderer.toJSON()),
                /"data-t3-terminal-session":"term-1"/,
              );
            } else if (outcome.includes("hang")) {
              NodeAssert.equal(
                statusText(),
                outcome.startsWith("ack-error")
                  ? "term-1: Terminal failed to start."
                  : "term-1: Terminal is exited.",
              );
            } else if (outcome === "start-failed") {
              NodeAssert.equal(statusText(), "term-1: spawn failed");
              for (const commit of commits)
                NodeAssert.doesNotMatch(commit, /Unknown terminal thread/);
            } else {
              NodeAssert.match(statusText(), /Unknown terminal thread/);
            }
            if (outcome.endsWith("r2")) {
              NodeAssert.equal(subscriptions, 3);
              for (const commit of commits)
                NodeAssert.doesNotMatch(commit, /Unknown terminal thread/);
            }
            NodeAssert.equal(attempts, 1);
          } finally {
            await act(async () => renderer.unmount());
          }
        },
      );
    }
  }
  for (const textFallback of [false, true])
    for (const startFails of [false, true])
      NodeTest.test(
        `${textFallback ? "text fallback" : "surface"}: the start ${startFails ? "fails" : "lands"}`,
        async () => {
          const drain = () => new Promise((resolve) => setImmediate(resolve));
          let finishAttach;
          const attach = new Promise((resolve) => (finishAttach = resolve));
          // The server knows the terminal only once a start has landed.
          let started = false;
          let rejected = 0;
          const hang = (signal) =>
            new Promise((resolve) =>
              signal.aborted
                ? resolve()
                : signal.addEventListener("abort", resolve, { once: true }),
            );
          const host = {
            ...(textFallback
              ? {}
              : {
                  readAsset: async (path) => ({
                    bytes: new Uint8Array([1, 2, 3]),
                    mediaType: path.endsWith(".woff2")
                      ? "font/woff2"
                      : path.endsWith(".txt")
                        ? "text/plain"
                        : "application/wasm",
                    sha256: "0".repeat(64),
                  }),
                }),
            invokeApi: async (request) => {
              if (request.id === "t3.ui/theme") return { tokens: {}, cssVars: {} };
              if (request.id !== "t3.terminal/control" || request.method !== "attach") return {};
              await attach;
              if (startFails) throw new Error("spawn failed");
              started = true;
              return sessionMetadata(request.input.terminalId);
            },
            subscribeApi: (request, signal) => ({
              async *[Symbol.asyncIterator]() {
                // The restarted server lists no session for this thread.
                if (request.id === "t3.terminal/sessions")
                  yield { value: { kind: "snapshot", terminals: [] } };
                if (request.id === "t3.terminal/output-events" && !started) {
                  rejected += 1;
                  throw new Error(UNKNOWN);
                }
                if (request.id === "t3.terminal/output-events")
                  yield {
                    streamId: "s2",
                    sequence: 1,
                    value: {
                      terminalId: "term-1",
                      streamEpoch: "epoch-2",
                      kind: "snapshot",
                      status: "running",
                      contents: "$ ",
                      retainedByteLength: 2,
                      truncated: false,
                      clearGeneration: 0,
                      contentsUnitStart: 0,
                      boundarySequence: 1,
                    },
                  };
                await hang(signal);
              },
            }),
          };
          const session = {
            signal: new AbortController().signal,
            context: {
              resource: { threadId: "t", environmentId: "e" },
              workspaceRevision: JSON.stringify(["/ws/root", null]),
            },
            visible: true,
            save() {},
            onVisibility: () => () => {},
            bindCommands: () => () => {},
            restoreState: { terminalIds: ["term-1"], activeTerminalId: "term-1" },
          };
          let renderer;
          await act(async () => {
            renderer = create(React.createElement(bundle.TerminalView, { host, session }), {
              createNodeMock: nodeMock,
            });
          });
          const settle = () =>
            act(async () => {
              for (let index = 0; index < 20; index++) await drain();
            });
          const statusText = () =>
            renderer.root
              .findAll(
                (node) => node.type === "output" && node.props["aria-label"] === "Output status",
              )
              .map((node) => node.children.join(""))
              .join("\n");
          try {
            await settle();
            NodeAssert.ok(rejected >= 1, "the resumed stream was rejected");
            NodeAssert.equal(statusText(), "term-1: Connecting…", "no raw error while starting");
            finishAttach();
            await settle();
            if (startFails) NodeAssert.match(statusText(), /spawn failed/);
            else NodeAssert.equal(statusText(), "term-1: Watching live output.");
          } finally {
            await act(async () => renderer.unmount());
          }
        },
      );
});
