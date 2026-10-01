import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";
import * as NodeTest from "node:test";
import {
  recordingUnavailableReason,
  recordingToastActions,
  runBrowserRecording,
  useBrowserRecording,
} from "./recording.ts";

const require = NodeModule.createRequire(import.meta.url);
const React = require("react");
const { act, create } = require("react-test-renderer");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const context = {
  client: "desktop",
  resource: {
    namespace: "test",
    id: "view",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
};
const held = { tabId: "tab", serverEpoch: "epoch" };
const artifact = {
  artifactRef: "pending-0f1e2d3c-4b5a-4968-8776-655443322110",
  mimeType: "video/webm",
  sizeBytes: 12,
  createdAt: "2026-09-30T00:00:00Z",
  saved: true,
};

function harness() {
  const calls = [];
  let phase = "idle";
  const listeners = new Set();
  const publish = (next) => {
    phase = next;
    for (const listener of listeners) listener({ ok: true, phase });
  };
  const host = {
    browserCapture: {
      version: "1.2.0",
      recordingSupport: { supported: true },
      artifactActions: {
        copyPath: { supported: true },
        reveal: { supported: true },
        copyImage: { supported: true },
        revealLabel: "Reveal in Finder",
      },
      copyArtifactPath: async () => ({ ok: true }),
      revealArtifact: async () => ({ ok: true }),
      async startRecording(request) {
        calls.push(["start", request]);
        publish("starting");
        publish("recording");
        return { ok: true, startedAt: artifact.createdAt };
      },
      async stopRecording(request) {
        calls.push(["stop", request]);
        publish("stopping");
        publish("idle");
        return { ok: true, artifact };
      },
      subscribeRecording(_request, listener) {
        listeners.add(listener);
        listener({ ok: true, phase });
        return () => listeners.delete(listener);
      },
    },
    async discoverApis() {
      return [{ id: "t3.ui/notifications", version: "1.1.0", selected: true }];
    },
    async invokeApi(request) {
      calls.push([request.method, request.input]);
      return request.method === "awaitAction" ? { closed: true } : { notificationId: "toast" };
    },
  };
  const lifetime = new AbortController();
  return {
    host,
    calls,
    publish,
    listeners,
    session: { context, signal: lifetime.signal },
    lifetime,
  };
}

NodeTest.test(
  "recording requires a probed host, desktop support, its grant and a shown page",
  () => {
    const fixture = harness();
    NodeAssert.equal(recordingUnavailableReason(fixture.host, held, "shown"), null);
    NodeAssert.match(
      recordingUnavailableReason(
        { browserCapture: { ...fixture.host.browserCapture, version: "1.1.0" } },
        held,
        "shown",
      ),
      /cannot record/,
    );
    NodeAssert.match(
      recordingUnavailableReason(
        {
          browserCapture: {
            ...fixture.host.browserCapture,
            recordingSupport: { supported: false, reason: "desktop-required" },
          },
        },
        held,
        "shown",
      ),
      /desktop/,
    );
    NodeAssert.match(
      recordingUnavailableReason(
        {
          browserCapture: {
            ...fixture.host.browserCapture,
            recordingSupport: {
              supported: false,
              reason: "grant-denied",
              grant: "t3.browser/recording",
            },
          },
        },
        held,
        "shown",
      ),
      /t3.browser\/recording/,
    );
    NodeAssert.match(recordingUnavailableReason(fixture.host, held, "hidden"), /shown/);
  },
);

NodeTest.test(
  "start is silent; stop reports native Recording saved with path and reveal, never image copy",
  async () => {
    const fixture = harness();
    await runBrowserRecording(fixture.host, fixture.session, held, false);
    NodeAssert.equal(
      fixture.calls.some(([method]) => method === "notify"),
      false,
    );
    await runBrowserRecording(fixture.host, fixture.session, held, true);
    const toast = fixture.calls.find(([method]) => method === "notify")[1];
    NodeAssert.equal(toast.title, "Recording saved");
    NodeAssert.equal(toast.actions[0].variant, "primary");
    NodeAssert.deepEqual(
      toast.actions.map((action) => action.id),
      ["reveal", "copy-path"],
    );
    NodeAssert.equal(
      fixture.calls.some(([method]) => method === "insertImage"),
      false,
    );
    NodeAssert.deepEqual(
      recordingToastActions(fixture.host.browserCapture).map((action) => action.id),
      ["reveal", "copy-path"],
    );
  },
);

NodeTest.test(
  "a transient subscription failure does not turn a running recording into a start control",
  async () => {
    const fixture = harness();
    let controls;
    function Probe() {
      const current = useBrowserRecording(fixture.host, fixture.session, held, "shown");
      React.useEffect(() => {
        controls = current;
      });
      return null;
    }
    let renderer;
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await act(async () => {
      fixture.publish("recording");
    });
    await act(async () => {
      for (const listener of fixture.listeners)
        listener({ ok: false, failure: { reason: "host-unavailable" } });
    });
    NodeAssert.equal(controls.phase, "recording");
    await act(async () => {
      await controls.toggle();
    });
    NodeAssert.equal(fixture.calls.find(([method]) => method === "stop")[0], "stop");
    await act(async () => {
      renderer.unmount();
    });
  },
);

NodeTest.test(
  "cancelled starts and empty stops stay silent; failures use native error titles",
  async () => {
    const fixture = harness();
    fixture.host.browserCapture.startRecording = async () => ({
      ok: false,
      failure: { reason: "cancelled", detail: "dismissed" },
    });
    fixture.host.browserCapture.stopRecording = async () => ({ ok: true, artifact: null });
    await runBrowserRecording(fixture.host, fixture.session, held, false);
    await runBrowserRecording(fixture.host, fixture.session, held, true);
    NodeAssert.equal(fixture.calls.length, 0);
    fixture.host.browserCapture.stopRecording = async () => ({
      ok: false,
      failure: { reason: "upload-failed", detail: "Upload rejected." },
    });
    await runBrowserRecording(fixture.host, fixture.session, held, true);
    NodeAssert.equal(
      fixture.calls.find(([method]) => method === "notify")[1].title,
      "Unable to stop recording",
    );
  },
);

NodeTest.test(
  "copy path restores Recording saved and flashes Copied rather than screenshot text",
  async () => {
    const fixture = harness();
    let action = true;
    fixture.host.invokeApi = async (request) => {
      fixture.calls.push([request.method, request.input]);
      if (request.method === "awaitAction") {
        if (action) {
          action = false;
          return { actionId: "copy-path" };
        }
        return { closed: true };
      }
      return { notificationId: "toast" };
    };
    await runBrowserRecording(fixture.host, fixture.session, held, true);
    await Promise.resolve();
    await Promise.resolve();
    const update = fixture.calls.find(([method]) => method === "update")[1];
    NodeAssert.equal(update.title, "Recording saved");
    NodeAssert.equal(update.flashAction.label, "Copied!");
  },
);

NodeTest.test(
  "hook follows native state and unsubscribes across session changes and unmount",
  async () => {
    const fixture = harness();
    let controls;
    let current = held;
    function Probe() {
      const nextControls = useBrowserRecording(fixture.host, fixture.session, current, "shown");
      React.useEffect(() => {
        controls = nextControls;
      });
      return null;
    }
    let renderer;
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    NodeAssert.equal(controls.phase, "idle");
    await act(async () => {
      controls.toggle();
    });
    NodeAssert.equal(controls.phase, "recording");
    await act(async () => {
      controls.toggle();
    });
    NodeAssert.equal(controls.phase, "idle");
    await act(async () => {
      fixture.publish("recording");
    });
    NodeAssert.equal(controls.phase, "recording");
    await act(async () => {
      current = { tabId: "other", serverEpoch: "epoch" };
      renderer.update(React.createElement(Probe));
    });
    NodeAssert.equal(fixture.listeners.size, 1);
    await act(async () => {
      renderer.unmount();
    });
    NodeAssert.equal(fixture.listeners.size, 0);
  },
);
