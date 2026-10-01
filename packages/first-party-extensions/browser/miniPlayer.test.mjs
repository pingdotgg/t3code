import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(import.meta.url);
const runtimeRequire = NodeModule.createRequire(
  new URL("../../extension-runtime/package.json", import.meta.url),
);
const { Ajv } = runtimeRequire("ajv");
const { uiPanelsApi } = await import("@t3tools/extension-sdk/catalogue");
const validator = new Ajv({ strict: true });
const inputValidators = new Map(
  uiPanelsApi.definition.methods.map((method) => [
    method.name,
    validator.compile(method.inputSchema),
  ]),
);
const { build } = require("esbuild");
const React = require("react");
const { act, create } = require("react-test-renderer");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let MiniPlayerButton;
let readBrowserMiniPlayer;
NodeTest.before(async () => {
  const built = await build({
    entryPoints: [NodeURL.fileURLToPath(new URL("miniPlayer.tsx", import.meta.url))],
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
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mini-player-"));
  const path = NodePath.join(directory, "bundle.mjs");
  try {
    await NodeFSP.writeFile(path, built.outputFiles[0].text);
    ({ MiniPlayerButton, readBrowserMiniPlayer } = await import(NodeURL.pathToFileURL(path).href));
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

const context = {
  client: "desktop",
  resource: {
    namespace: "t3.browser",
    id: "view",
    environmentId: "env-a",
    projectId: "project-a",
    threadId: "thread-a",
  },
};
const held = { tabId: "tab-a", serverEpoch: "epoch-a", engineGeneration: "guest-1" };
const signal = new AbortController().signal;

NodeTest.test(
  "tab switches read local state, native X updates pressed state, and unreachable pages disable float",
  async () => {
    const fixture = hostFixture();
    const view = await mount(fixture.host);
    NodeAssert.equal(view.button().props["aria-pressed"], false);
    await act(async () => fixture.publish(held.tabId));
    NodeAssert.equal(view.button().props["aria-pressed"], true);
    await act(async () => fixture.publish(null));
    NodeAssert.equal(view.button().props["aria-label"], "Float preview over chat");
    await view.update({ held: { ...held, tabId: "tab-b" } });
    NodeAssert.equal(fixture.calls.length, 0);
    await act(async () => fixture.publishReady(false));
    NodeAssert.equal(view.button().props.disabled, true);
    await act(async () => fixture.publishReady(true));
    NodeAssert.equal(view.button().props.disabled, false);
    await view.update({ available: false });
    NodeAssert.equal(view.button().props.disabled, true);
    await view.close();
  },
);

NodeTest.test("host failures never leak raw error text", async () => {
  const fixture = hostFixture({
    toggle: async () => {
      throw new Error("private-host-detail");
    },
  });
  const messages = [];
  const view = await mount(fixture.host);
  await view.update({ report: (message) => messages.push(message) });
  await view.click();
  NodeAssert.deepEqual(messages, ["Floating preview unavailable. Try again."]);
  await view.close();
});

function hostFixture({ version = "1.1.0", supported = true, toggle } = {}) {
  const calls = [];
  let active = null;
  let ready = true;
  const listeners = new Set();
  const publish = (tabId) => {
    active = tabId;
    for (const listener of listeners) listener();
  };
  const host = {
    React,
    browserMiniPlayer: {
      version: 1,
      supported,
      read: () => active,
      canFloat: () => ready,
      subscribe(_context, listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    discoverApis: async () => [{ id: "t3.ui/panels", version }],
    async invokeApi(request) {
      const validate = inputValidators.get(request.method);
      NodeAssert.ok(validate(request.input), JSON.stringify(validate.errors));
      calls.push(request);
      if (request.method === "getCapabilities")
        return {
          adapter: "host.ui.panels",
          clients: [],
          operations: { getBrowserMiniPlayer: supported, setBrowserMiniPlayer: supported },
        };
      if (request.method === "getBrowserMiniPlayer") return { tabId: active };
      if (toggle) return toggle(request);
      publish(request.input.open ? request.input.tabId : null);
      return { tabId: active };
    },
  };
  return {
    host,
    calls,
    publish,
    publishReady(value) {
      ready = value;
      for (const listener of listeners) listener();
    },
  };
}

async function mount(host) {
  let props = {
    host,
    session: { context, signal },
    held,
    visible: true,
    style: {},
    report: (message) => {
      throw new Error(message);
    },
  };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(MiniPlayerButton, props));
  });
  return {
    button: () => renderer.root.findByType("button"),
    buttons: () => renderer.root.findAllByType("button"),
    async click() {
      await act(async () => {
        renderer.root.findByType("button").props.onClick();
      });
    },
    async update(next) {
      props = { ...props, ...next };
      await act(async () => {
        renderer.update(React.createElement(MiniPlayerButton, props));
      });
    },
    async close() {
      await act(async () => {
        renderer.unmount();
      });
    },
  };
}

NodeTest.test(
  "older hosts and unsupported clients never dispatch a mini-player mutation",
  async () => {
    const old = hostFixture({ version: "1.0.0" });
    await NodeAssert.rejects(
      readBrowserMiniPlayer(old.host, { context }, signal),
      /newer T3 Code host/,
    );
    NodeAssert.equal(old.calls.length, 0);
    const web = hostFixture({ supported: false });
    const view = await mount(web.host);
    NodeAssert.equal(view.buttons().length, 0);
    NodeAssert.deepEqual(web.calls, []);
    await view.close();
  },
);

NodeTest.test(
  "open, hide, reopen and close reflect the host's native mini-player state",
  async () => {
    const fixture = hostFixture();
    const view = await mount(fixture.host);
    NodeAssert.equal(view.button().props["aria-label"], "Float preview over chat");
    await view.click();
    NodeAssert.equal(view.button().props["aria-label"], "Close floating preview");
    await view.update({ visible: false });
    const hiddenCalls = fixture.calls.length;
    await view.update({ visible: true });
    NodeAssert.equal(fixture.calls.length, hiddenCalls);
    NodeAssert.equal(view.button().props["aria-label"], "Close floating preview");
    await view.click();
    NodeAssert.equal(view.button().props["aria-label"], "Float preview over chat");
    NodeAssert.deepEqual(
      fixture.calls
        .filter((call) => call.method === "setBrowserMiniPlayer")
        .map((call) => call.input),
      [
        { tabId: held.tabId, serverEpoch: held.serverEpoch, open: true },
        { tabId: held.tabId, serverEpoch: held.serverEpoch, open: false },
      ],
    );
    await view.close();
  },
);

NodeTest.test(
  "a late toggle from another thread cannot overwrite the new thread's state",
  async () => {
    let complete;
    const fixture = hostFixture({
      toggle: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    });
    const view = await mount(fixture.host);
    await view.click();
    NodeAssert.equal(view.button().props.disabled, true);
    await view.update({
      session: {
        context: { ...context, resource: { ...context.resource, threadId: "thread-b" } },
        signal,
      },
    });
    NodeAssert.equal(view.button().props.disabled, false);
    await act(async () => {
      complete({ tabId: held.tabId });
    });
    NodeAssert.equal(view.button().props["aria-label"], "Float preview over chat");
    NodeAssert.equal(view.button().props.disabled, false);
    await view.close();
  },
);

NodeTest.test(
  "an aborted toggle clears pending state when its tab becomes active again",
  async () => {
    let complete;
    const fixture = hostFixture({
      toggle: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    });
    const view = await mount(fixture.host);
    await view.click();
    NodeAssert.equal(view.button().props.disabled, true);
    await view.update({ held: { ...held, tabId: "tab-b" } });
    await act(async () => {
      complete({ tabId: held.tabId });
    });
    await view.update({ held });
    NodeAssert.equal(view.button().props.disabled, false);
    await view.close();
  },
);
