import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(import.meta.url);
const { build } = require("esbuild");
const React = require("react");
const { act, create } = require("react-test-renderer");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let BrowserCaptureButtons;
NodeTest.before(async () => {
  const built = await build({
    entryPoints: [NodeURL.fileURLToPath(new URL("./annotateButton.tsx", import.meta.url))],
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
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-capture-controls-"));
  const path = NodePath.join(dir, "controls.mjs");
  try {
    await NodeFSP.writeFile(path, built.outputFiles[0].text);
    ({ BrowserCaptureButtons } = await import(NodeURL.pathToFileURL(path).href));
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

function harness() {
  const calls = [];
  const listeners = new Set();
  let phase = "idle";
  const publish = (next) => {
    phase = next;
    for (const listener of listeners) listener({ ok: true, phase });
  };
  const artifactRef = "pending-0f1e2d3c-4b5a-4968-8776-655443322110";
  const lifetime = new AbortController();
  const host = {
    version: 1,
    React,
    browserCapture: {
      id: "t3.browser/capture",
      version: "1.2.0",
      support: { supported: true },
      recordingSupport: { supported: true },
      async capture() {
        calls.push("screenshot");
        return {
          ok: true,
          artifact: {
            artifactRef,
            mimeType: "image/png",
            sizeBytes: 1,
            width: 1,
            height: 1,
            target: "page",
            pageUrl: null,
            pageTitle: null,
          },
        };
      },
      async startRecording() {
        calls.push("start");
        publish("starting");
        publish("recording");
        return { ok: true, startedAt: "2026-09-30T00:00:00Z" };
      },
      async stopRecording() {
        calls.push("stop");
        publish("stopping");
        publish("idle");
        return {
          ok: true,
          artifact: {
            artifactRef,
            mimeType: "video/webm",
            sizeBytes: 1,
            createdAt: "2026-09-30T00:00:00Z",
            saved: true,
          },
        };
      },
      subscribeRecording(_request, listener) {
        listeners.add(listener);
        listener({ ok: true, phase });
        return () => listeners.delete(listener);
      },
    },
    async discoverApis() {
      return [];
    },
    async invokeApi(request) {
      calls.push(request.method === "notify" ? request.input.title : request.method);
      return request.method === "insertImage"
        ? { inserted: true, target: "env:thread" }
        : { notificationId: "toast" };
    },
  };
  return {
    host,
    calls,
    publish,
    lifetime,
    listeners,
    session: {
      context: {
        client: "desktop",
        resource: {
          namespace: "test",
          id: "view",
          environmentId: "env",
          projectId: "project",
          threadId: "thread",
        },
      },
      signal: lifetime.signal,
    },
  };
}

NodeTest.test(
  "the actual header keeps screenshot-to-chat and Shift-click start / ordinary-click stop distinct",
  async () => {
    const fixture = harness();
    let renderer;
    let page = "shown";
    const render = () =>
      React.createElement(BrowserCaptureButtons, {
        host: fixture.host,
        session: fixture.session,
        held: { tabId: "tab", serverEpoch: "epoch" },
        page,
        style: {},
      });
    await act(async () => {
      renderer = create(render());
    });
    const click = async (label, shiftKey) =>
      act(async () => {
        renderer.root.findByProps({ "aria-label": label }).props.onClick({ shiftKey });
      });
    await click("Capture screenshot", false);
    NodeAssert.deepEqual(fixture.calls, ["screenshot", "insertImage", "Screenshot saved"]);
    await click("Capture screenshot", true);
    NodeAssert.equal(
      renderer.root.findByProps({ "aria-label": "Stop recording" }).props.disabled,
      false,
    );
    page = "hidden";
    await act(async () => {
      renderer.update(render());
    });
    await click("Stop recording", false);
    NodeAssert.deepEqual(fixture.calls, [
      "screenshot",
      "insertImage",
      "Screenshot saved",
      "start",
      "stop",
      "Recording saved",
    ]);
    NodeAssert.equal(
      renderer.root.findByProps({ "aria-label": "Capture screenshot" }).props.disabled,
      true,
    );
    await act(async () => {
      renderer.unmount();
    });
    NodeAssert.equal(fixture.listeners.size, 0);
    fixture.lifetime.abort();
  },
);

NodeTest.test(
  "native recordings started elsewhere become stoppable, while web capture stays disabled",
  async () => {
    const fixture = harness();
    let renderer;
    const render = () =>
      React.createElement(BrowserCaptureButtons, {
        host: fixture.host,
        session: fixture.session,
        held: { tabId: "tab", serverEpoch: "epoch" },
        page: "shown",
        style: {},
      });
    await act(async () => {
      renderer = create(render());
    });
    await act(async () => {
      fixture.publish("recording");
    });
    await act(async () => {
      renderer.root
        .findByProps({ "aria-label": "Stop recording" })
        .props.onClick({ shiftKey: false });
    });
    NodeAssert.deepEqual(fixture.calls, ["stop", "Recording saved"]);
    fixture.host.browserCapture = {
      ...fixture.host.browserCapture,
      support: { supported: false, reason: "desktop-required" },
      recordingSupport: { supported: false, reason: "desktop-required" },
    };
    await act(async () => {
      renderer.update(render());
    });
    NodeAssert.equal(
      renderer.root.findByProps({ "aria-label": "Capture screenshot" }).props.disabled,
      true,
    );
    await act(async () => {
      renderer.unmount();
    });
    fixture.lifetime.abort();
  },
);

NodeTest.test(
  "kit capture controls keep native ordering and stop styling without changing recording actions",
  async () => {
    const fixture = harness();
    const names = [
      "Button",
      "Input",
      "InputGroup",
      "InputGroupAddon",
      "Toolbar",
      "Menu",
      "MenuTrigger",
      "MenuPopup",
      "MenuSub",
      "MenuSubTrigger",
      "MenuSubPopup",
      "MenuGroup",
      "MenuRow",
      "MenuNote",
      "MenuItem",
      "MenuSeparator",
      "MenuGroupLabel",
      "MenuRadioGroup",
      "MenuRadioItem",
      "TreeRow",
      "Icon",
    ];
    fixture.host.uiKit = {
      version: 1,
      ...Object.fromEntries(names.map((name) => [name, () => null])),
      Button: ({ variant, size: _size, ...props }) =>
        React.createElement("button", { ...props, "data-kit-variant": variant }),
    };
    let renderer;
    try {
      await act(async () => {
        renderer = create(
          React.createElement(BrowserCaptureButtons, {
            host: fixture.host,
            session: fixture.session,
            held: { tabId: "tab", serverEpoch: "epoch" },
            page: "shown",
            style: {},
          }),
        );
      });
      NodeAssert.deepEqual(
        renderer.root.findAllByType("button").map((button) => button.props["aria-label"]),
        ["Annotate preview", "Capture screenshot"],
      );
      await act(async () =>
        renderer.root
          .findByProps({ "aria-label": "Capture screenshot" })
          .props.onClick({ shiftKey: true }),
      );
      const stop = renderer.root
        .findAllByType("button")
        .find((button) => button.props["aria-label"] === "Stop recording");
      NodeAssert.equal(stop.props["data-kit-variant"], "secondary");
      NodeAssert.equal(
        renderer.root.findAll((node) => node.props.className !== undefined).length,
        0,
      );
      await act(async () => stop.props.onClick({ shiftKey: false }));
      NodeAssert.deepEqual(fixture.calls, ["start", "stop", "Recording saved"]);
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      fixture.lifetime.abort();
    }
  },
);
