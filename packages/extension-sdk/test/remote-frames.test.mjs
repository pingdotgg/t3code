import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { createElement, useEffect } from "react";
import { create, act } from "react-test-renderer";
import { useRemoteBrowserFrames } from "../dist/authoring.js";
import { BROWSER_FRAMES } from "../dist/catalogue.js";
import * as React from "react";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const context = {
  resource: {
    namespace: "example.frames",
    id: "view",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
  client: "web",
};

const sessionRef = { tabId: "tab-1", serverEpoch: "epoch-1", engineGeneration: null };

function makeSession(signal) {
  return {
    context,
    signal,
    restoring: false,
    visible: true,
    onVisibility: () => () => {},
    restoreState: null,
    publish: () => false,
    save: () => false,
    invoke: async () => ({}),
    onDispose: () => {},
  };
}

/** Records every invokeApi call and drives `present` capture. */
function makeHost(options = {}) {
  const calls = [];
  let presentRequest = null;
  const mints = [];
  let mintCount = 0;
  const host = {
    React,
    browserFrames: {
      id: BROWSER_FRAMES,
      version: "1.0.0",
      present(request) {
        presentRequest = request;
        return {
          ok: true,
          view: {
            state: {
              status: "connecting",
              inputConnected: false,
              droppedFrames: 0,
              rejectedInput: 0,
            },
            onDidChangeState: () => () => {},
            detach() {},
          },
        };
      },
    },
    invokeApi(request, signal) {
      calls.push({ method: request.method, input: request.input, signal });
      if (request.method === "getCapabilities") {
        return Promise.resolve({ stream: { supported: true } });
      }
      if (request.method === "createPresentationUrl") {
        mintCount += 1;
        const mint = {
          url: `/api/assets/token-${mintCount}/present`,
          expiresAt: options.expiresAt ?? Date.now() + 60_000,
        };
        mints.push(mint);
        return Promise.resolve(options.mintGate).then(() => mint);
      }
      if (request.method === "openStream") {
        return Promise.resolve({ ticket: "stream-ticket", expiresAt: Date.now() + 60_000 });
      }
      if (request.method === "openInput") {
        return Promise.resolve({
          leaseId: "lease-1",
          inputTicket: "input-ticket",
          expiresAt: Date.now() + 60_000,
        });
      }
      if (request.method === "closeInput") {
        return Promise.resolve({ closed: true });
      }
      if (request.method === "releasePresentation") {
        return Promise.resolve({ released: true });
      }
      return Promise.reject(new Error(`unexpected invoke ${request.method}`));
    },
    subscribeApi: async function* () {},
    discoverApis: async () => [],
    invokeTool: async () => ({}),
  };
  return {
    host,
    calls,
    mints,
    get presentRequest() {
      return presentRequest;
    },
  };
}

function View({ host, session, options }) {
  const frames = useRemoteBrowserFrames(host, session, options);
  useEffect(() => {
    frames.ref({});
    return () => frames.ref(null);
  }, [frames.ref]);
  return null;
}

async function flush() {
  // Several microtask turns: getCapabilities → present → setState settle.
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

NodeTest.test("concurrent stream/input acquisition shares one in-flight mint", async () => {
  const bag = makeHost();
  const { host, calls } = bag;
  const session = makeSession(new AbortController().signal);
  let renderer;
  await act(async () => {
    renderer = create(
      createElement(View, { host, session, options: { session: sessionRef, enabled: true } }),
    );
  });
  await flush();
  NodeAssert.ok(bag.presentRequest, "present captured");

  const [stream, input] = await Promise.all([
    bag.presentRequest.openStream(),
    bag.presentRequest.openInput(),
  ]);
  NodeAssert.ok(stream && input, "both mints resolved");

  const mints = calls.filter((c) => c.method === "createPresentationUrl");
  NodeAssert.equal(mints.length, 1, "one mint for concurrent acquisition");
  await act(async () => {
    renderer.unmount();
  });
});

NodeTest.test("cleanup releases every minted claim, including rotated ones", async () => {
  // Short expiry forces the second mintSurfaceLease() to rotate the claim.
  const bag = makeHost({ expiresAt: Date.now() + 1_000 });
  const { host, calls, mints } = bag;
  const session = makeSession(new AbortController().signal);
  let renderer;
  await act(async () => {
    renderer = create(
      createElement(View, { host, session, options: { session: sessionRef, enabled: true } }),
    );
  });
  await flush();

  await bag.presentRequest.openStream();
  await bag.presentRequest.openStream(); // claim rotated: two distinct slots
  await bag.presentRequest.openInput();
  NodeAssert.equal(mints.length, 3, "rotation minted fresh claims");

  await act(async () => {
    renderer.unmount();
  });
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

  const released = calls
    .filter((c) => c.method === "releasePresentation")
    .map((c) => c.input.presentationUrl);
  NodeAssert.deepEqual(released.sort(), mints.map((m) => m.url).sort());

  const close = calls.find((c) => c.method === "closeInput");
  NodeAssert.ok(close, "input lease closed");
  NodeAssert.equal(close.input.leaseId, "lease-1");
  // The close names the claim that minted the lease, not the rotated newest.
  NodeAssert.equal(close.input.surfaceLease, mints.at(-1).url);
});

NodeTest.test("cleanup invocations still fire after the session signal aborted", async () => {
  const bag = makeHost();
  const { host, calls } = bag;
  const controller = new AbortController();
  const session = makeSession(controller.signal);
  let renderer;
  await act(async () => {
    renderer = create(
      createElement(View, { host, session, options: { session: sessionRef, enabled: true } }),
    );
  });
  await flush();
  await bag.presentRequest.openInput();

  controller.abort();
  await act(async () => {
    renderer.unmount();
  });
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

  const cleanupCalls = calls.filter(
    (c) => c.method === "releasePresentation" || c.method === "closeInput",
  );
  NodeAssert.ok(cleanupCalls.length >= 2, "cleanup invokes recorded");
  for (const call of cleanupCalls) {
    NodeAssert.equal(call.signal.aborted, false, `${call.method} ran under a live signal`);
  }
});

NodeTest.test("cleanup waits for an in-flight mint and releases its claim", async () => {
  // The mint resolves only after teardown: without the settle-wait the claim
  // the server minted would never be released and would live out its TTL.
  let openGate;
  const mintGate = new Promise((resolve) => {
    openGate = resolve;
  });
  const bag = makeHost({ mintGate });
  const { host, calls, mints } = bag;
  const session = makeSession(new AbortController().signal);
  let renderer;
  await act(async () => {
    renderer = create(
      createElement(View, { host, session, options: { session: sessionRef, enabled: true } }),
    );
  });
  await flush();

  const stream = bag.presentRequest.openStream(); // mint starts, gate held
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
  await act(async () => {
    renderer.unmount();
  });
  openGate(); // mint lands after teardown already ran
  await stream;
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

  NodeAssert.equal(mints.length, 1);
  const released = calls
    .filter((c) => c.method === "releasePresentation")
    .map((c) => c.input.presentationUrl);
  NodeAssert.deepEqual(released, [mints[0].url]);
});
