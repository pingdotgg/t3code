import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import React from "react";
import TestRenderer from "react-test-renderer";
import { useBrowserSurfaceSlot } from "../dist/authoring.js";
import {
  BROWSER_OPERATE,
  BROWSER_SURFACE,
  BROWSER_SURFACE_REQUIRED_GRANTS,
  BROWSER_SURFACE_VERSION,
  GENERIC_API_CATALOGUE,
  HOST_CAPABILITY_GRANTS,
} from "../dist/catalogue.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const context = {
  client: "test",
  resource: {
    namespace: "test.browser",
    id: "view",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
};
const sessionRef = { tabId: "tab-1", serverEpoch: "epoch-1" };
const rect = { x: 4, y: 8, width: 320, height: 200 };

function makeSession() {
  const lifetime = new AbortController();
  return {
    context,
    signal: lifetime.signal,
    visible: true,
    onVisibility: () => () => {},
    lifetime,
  };
}

// The hook observes DOM geometry; node tests stub the globals it uses.
function domStubs() {
  const previous = {
    ResizeObserver: globalThis.ResizeObserver,
    window: globalThis.window,
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const polls = [];
  let intervalId = 0;
  globalThis.setInterval = (fn) => {
    polls.push(fn);
    return ++intervalId;
  };
  globalThis.clearInterval = (id) => {
    polls.splice(0, polls.length);
    return id;
  };
  // Retry timers are captured, not scheduled — tests fire them explicitly.
  const timeouts = new Map();
  let timeoutId = 0;
  globalThis.setTimeout = (fn) => {
    const id = ++timeoutId;
    timeouts.set(id, fn);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    timeouts.delete(id);
  };
  const observed = [];
  globalThis.ResizeObserver = class {
    observe(element) {
      observed.push(element);
    }
    disconnect() {}
  };
  const listeners = new Map();
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener(type, fn) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((item) => item !== fn),
      );
    },
  };
  // Tests override elementsFromPoint to simulate occlusion.
  const stub = {
    documentElement: {},
    defaultView: { innerWidth: 1280, innerHeight: 800 },
    elementsFromPoint: () => [],
  };
  globalThis.document = stub;
  globalThis.getComputedStyle = (node) =>
    node?.computedStyle ?? { overflowX: "visible", overflowY: "visible" };
  return {
    observed,
    listeners,
    polls,
    timeouts,
    fireTimeouts() {
      const pending = [...timeouts.values()];
      timeouts.clear();
      for (const fn of pending) fn();
    },
    document: stub,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

// Minimal element mock: geometry + parent chain + ownerDocument. Border-box
// geometry defaults to the borderless case (padding box == rect); clip tests
// override client*/offset* to model border and scrollbar.
function fakeElement(
  rectValue,
  { parent = null, document, computedStyle, border = 0, scrollbar = 0 } = {},
) {
  const element = {
    rect: rectValue,
    parentElement: parent,
    ownerDocument: document,
    computedStyle,
    clientLeft: border,
    clientTop: border,
    offsetWidth: rectValue.width,
    offsetHeight: rectValue.height,
    clientWidth: rectValue.width - border * 2 - scrollbar,
    clientHeight: rectValue.height - border * 2 - scrollbar,
    rectReads: 0,
    contains: (node) => node.parentElement === element,
    getBoundingClientRect() {
      element.rectReads += 1;
      return element.rect;
    },
  };
  return element;
}

function fakeLeaseHost({ supported = true } = {}) {
  const presentation = supported
    ? { supported: true }
    : { supported: false, reason: "desktop-required" };
  const calls = { acquire: [], presents: [], released: 0, listeners: new Set() };
  const lease = {
    session: sessionRef,
    state: { kind: "active", presentation },
    onDidChangeState(listener) {
      calls.listeners.add(listener);
      return () => calls.listeners.delete(listener);
    },
    present(rect, visible, cornerRadius, zIndex) {
      calls.presents.push({ rect, visible, cornerRadius, zIndex });
      return "accepted";
    },
    release() {
      calls.released += 1;
      lease.state = { kind: "ended", reason: "released" };
      for (const listener of calls.listeners) listener(lease.state);
    },
  };
  const host = {
    React,
    browserSurface: {
      id: BROWSER_SURFACE,
      version: BROWSER_SURFACE_VERSION,
      presentation,
      acquire(request) {
        calls.acquire.push(request);
        return { ok: true, lease };
      },
    },
  };
  return { host, calls, lease };
}

function render(View, nodeMock) {
  let renderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(React.createElement(View), {
      createNodeMock: () => nodeMock,
    });
  });
  return renderer;
}

NodeTest.test("t3.browser/surface contract surface is named, versioned and grant-scoped", () => {
  NodeAssert.equal(BROWSER_SURFACE, "t3.browser/surface");
  NodeAssert.equal(BROWSER_SURFACE_VERSION, "1.0.0");
  NodeAssert.deepEqual(BROWSER_SURFACE_REQUIRED_GRANTS, [
    "t3.browser/sessions",
    "t3.browser/surface",
  ]);
  NodeAssert.ok(HOST_CAPABILITY_GRANTS.includes(BROWSER_SURFACE));
  // The surface grant is host-local: it must never appear as a brokered API.
  NodeAssert.equal(
    GENERIC_API_CATALOGUE.some((api) => api.id === BROWSER_SURFACE),
    false,
  );
  NodeAssert.equal(BROWSER_OPERATE, "t3.browser/operate");
});

NodeTest.test("useBrowserSurfaceSlot reports host-unavailable without the capability", async () => {
  const dom = domStubs();
  try {
    const session = makeSession();
    const host = { React };
    let slot;
    function View() {
      const value = useBrowserSurfaceSlot(host, session, {
        session: sessionRef,
        visible: true,
      });
      React.useEffect(() => {
        slot = value;
      }, [value]);
      return React.createElement("div", { ref: value.ref });
    }
    const renderer = render(View, fakeElement(rect, { document: dom.document }));
    NodeAssert.equal(slot.lease, null);
    NodeAssert.equal(slot.denial.reason, "host-unavailable");
    // A missing capability is not transient — no retry is scheduled.
    NodeAssert.equal(dom.timeouts.size, 0);
    await TestRenderer.act(async () => renderer.unmount());
  } finally {
    dom.restore();
  }
});

NodeTest.test("useBrowserSurfaceSlot acquires, presents element bounds and releases", async () => {
  const dom = domStubs();
  try {
    const session = makeSession();
    const { host, calls, lease } = fakeLeaseHost();
    let slot;
    function View() {
      const value = useBrowserSurfaceSlot(host, session, {
        session: sessionRef,
        visible: true,
        cornerRadius: 6,
      });
      React.useEffect(() => {
        slot = value;
      }, [value]);
      return React.createElement("div", { ref: value.ref });
    }
    const renderer = render(View, fakeElement(rect, { document: dom.document }));
    NodeAssert.equal(calls.acquire.length, 1);
    NodeAssert.deepEqual(calls.acquire[0].context, context);
    NodeAssert.deepEqual(calls.acquire[0].session, sessionRef);
    NodeAssert.equal(calls.acquire[0].signal, session.signal);
    // First present fires from the layout effect with the element's bounds.
    NodeAssert.deepEqual(calls.presents, [
      { rect: { x: 4, y: 8, width: 320, height: 200 }, visible: true, cornerRadius: 6, zIndex: 30 },
    ]);
    NodeAssert.equal(slot.lease, lease);
    NodeAssert.equal(slot.denial, null);
    await TestRenderer.act(async () => renderer.unmount());
    NodeAssert.equal(calls.released, 1);
    NodeAssert.equal(lease.state.kind, "ended");
  } finally {
    dom.restore();
  }
});

NodeTest.test("useBrowserSurfaceSlot surfaces a named acquire denial", async () => {
  const dom = domStubs();
  try {
    const session = makeSession();
    const host = {
      React,
      browserSurface: {
        id: BROWSER_SURFACE,
        version: BROWSER_SURFACE_VERSION,
        presentation: { supported: true },
        acquire: () => ({
          ok: false,
          denial: {
            reason: "grant-denied",
            grant: BROWSER_SURFACE,
            detail: "missing surface grant",
          },
        }),
      },
    };
    let slot;
    function View() {
      const value = useBrowserSurfaceSlot(host, session, {
        session: sessionRef,
        visible: true,
      });
      React.useEffect(() => {
        slot = value;
      }, [value]);
      return React.createElement("div", { ref: value.ref });
    }
    const renderer = render(View, fakeElement(rect, { document: dom.document }));
    NodeAssert.equal(slot.lease, null);
    NodeAssert.equal(slot.denial.reason, "grant-denied");
    NodeAssert.equal(slot.denial.grant, BROWSER_SURFACE);
    // Only host-unavailable is transient — a grant denial never retries.
    NodeAssert.equal(dom.timeouts.size, 0);
    await TestRenderer.act(async () => renderer.unmount());
  } finally {
    dom.restore();
  }
});

NodeTest.test(
  "useBrowserSurfaceSlot clips to overflow ancestors and hides when occluded",
  async () => {
    const dom = domStubs();
    try {
      const session = makeSession();
      const { host, calls } = fakeLeaseHost();
      // Slot is taller than its overflow-hidden container: bottom clipped away.
      const container = fakeElement(
        { x: 0, y: 100, width: 1280, height: 600 },
        { document: dom.document, computedStyle: { overflowX: "hidden", overflowY: "hidden" } },
      );
      const slotElement = fakeElement(rect, { parent: container, document: dom.document });
      function View() {
        const value = useBrowserSurfaceSlot(host, session, {
          session: sessionRef,
          visible: true,
        });
        return React.createElement("div", { ref: value.ref });
      }
      const renderer = render(View, slotElement);
      try {
        // Only the visible intersection may be presented — the webview is not a
        // DOM descendant and would otherwise paint over the container's bounds.
        NodeAssert.deepEqual(calls.presents, [
          {
            rect: { x: 4, y: 100, width: 320, height: 108 },
            visible: true,
            cornerRadius: 0,
            zIndex: 30,
          },
        ]);
        // A foreign overlay covering the slot hides the surface entirely.
        const modal = { closest: () => null };
        dom.document.elementsFromPoint = () => [modal, slotElement];
        TestRenderer.act(() => {
          for (const listener of dom.listeners.get("scroll") ?? []) listener();
        });
        NodeAssert.equal(calls.presents.at(-1).visible, false);
        NodeAssert.deepEqual(calls.presents.at(-1).rect, {
          x: 4,
          y: 100,
          width: 320,
          height: 108,
        });
        // A presented native surface above the slot is not occlusion.
        const presented = {
          closest: (sel) => (sel === "[data-preview-viewport]" ? presented : null),
        };
        dom.document.elementsFromPoint = () => [presented, slotElement];
        TestRenderer.act(() => {
          for (const listener of dom.listeners.get("scroll") ?? []) listener();
        });
        NodeAssert.equal(calls.presents.at(-1).visible, true);
      } finally {
        await TestRenderer.act(async () => renderer.unmount());
      }
    } finally {
      dom.restore();
    }
  },
);

NodeTest.test(
  "useBrowserSurfaceSlot clips to the ancestor padding box, not its border box",
  async () => {
    const dom = domStubs();
    try {
      const session = makeSession();
      const { host, calls } = fakeLeaseHost();
      // 10px border + 8px scrollbar: overflow clips at (110,110) 172x172, not
      // the border box — the webview must never cover the border or scrollbar.
      const container = fakeElement(
        { x: 100, y: 100, width: 200, height: 200 },
        {
          document: dom.document,
          computedStyle: { overflowX: "auto", overflowY: "auto" },
          border: 10,
          scrollbar: 8,
        },
      );
      const slotElement = fakeElement(
        { x: 100, y: 100, width: 200, height: 200 },
        { parent: container, document: dom.document },
      );
      function View() {
        const value = useBrowserSurfaceSlot(host, session, {
          session: sessionRef,
          visible: true,
        });
        return React.createElement("div", { ref: value.ref });
      }
      const renderer = render(View, slotElement);
      try {
        NodeAssert.deepEqual(calls.presents.at(-1).rect, {
          x: 110,
          y: 110,
          width: 172,
          height: 172,
        });
      } finally {
        await TestRenderer.act(async () => renderer.unmount());
      }
    } finally {
      dom.restore();
    }
  },
);

NodeTest.test(
  "useBrowserSurfaceSlot runs no geometry or occlusion work while hidden or uncomposited",
  async () => {
    const dom = domStubs();
    try {
      const session = makeSession();

      // Hidden slot: the lease is held but no DOM reads, presents or poll.
      const hidden = fakeLeaseHost();
      const slotElement = fakeElement(rect, { document: dom.document });
      let visible = false;
      function HiddenView() {
        const value = useBrowserSurfaceSlot(hidden.host, session, {
          session: sessionRef,
          visible,
        });
        return React.createElement("div", { ref: value.ref });
      }
      const hiddenRenderer = render(HiddenView, slotElement);
      try {
        NodeAssert.equal(hidden.calls.presents.length, 0);
        NodeAssert.equal(slotElement.rectReads, 0);
        NodeAssert.equal(dom.polls.length, 0);
        // Flipping visible resumes presentation and the occlusion poll…
        visible = true;
        await TestRenderer.act(async () => hiddenRenderer.update(React.createElement(HiddenView)));
        NodeAssert.equal(hidden.calls.presents.at(-1).visible, true);
        NodeAssert.equal(dom.polls.length, 1);
        // …and hiding again sends exactly one transition, then stops the poll.
        const presentsBefore = hidden.calls.presents.length;
        visible = false;
        await TestRenderer.act(async () => hiddenRenderer.update(React.createElement(HiddenView)));
        NodeAssert.equal(hidden.calls.presents.length, presentsBefore + 1);
        NodeAssert.equal(hidden.calls.presents.at(-1).visible, false);
        NodeAssert.equal(dom.polls.length, 0);
      } finally {
        await TestRenderer.act(async () => hiddenRenderer.unmount());
      }
      NodeAssert.equal(hidden.calls.released, 1);

      // Uncomposited host: lease still acquires, but no observer or poll.
      const unsupported = fakeLeaseHost({ supported: false });
      const pollsBefore = dom.polls.length;
      const observedBefore = dom.observed.length;
      function UnsupportedView() {
        const value = useBrowserSurfaceSlot(unsupported.host, session, {
          session: sessionRef,
          visible: true,
        });
        return React.createElement("div", { ref: value.ref });
      }
      const unsupportedElement = fakeElement(rect, { document: dom.document });
      const unsupportedRenderer = render(UnsupportedView, unsupportedElement);
      try {
        NodeAssert.equal(unsupported.calls.acquire.length, 1);
        NodeAssert.equal(unsupported.calls.presents.length, 0);
        NodeAssert.equal(unsupportedElement.rectReads, 0);
        NodeAssert.equal(dom.polls.length, pollsBefore);
        NodeAssert.equal(dom.observed.length, observedBefore);
      } finally {
        await TestRenderer.act(async () => unsupportedRenderer.unmount());
      }
      NodeAssert.equal(unsupported.calls.released, 1);
    } finally {
      dom.restore();
    }
  },
);

NodeTest.test(
  "useBrowserSurfaceSlot retries a transient host-unavailable denial and recovers",
  async () => {
    const dom = domStubs();
    try {
      const session = makeSession();
      const { host, calls, lease } = fakeLeaseHost();
      let denied = true;
      host.browserSurface.acquire = (request) => {
        calls.acquire.push(request);
        return denied
          ? {
              ok: false,
              denial: { reason: "host-unavailable", detail: "shell synchronizing" },
            }
          : { ok: true, lease };
      };
      let slot;
      function View() {
        const value = useBrowserSurfaceSlot(host, session, {
          session: sessionRef,
          visible: true,
        });
        React.useEffect(() => {
          slot = value;
        }, [value]);
        return React.createElement("div", { ref: value.ref });
      }
      const renderer = render(View, fakeElement(rect, { document: dom.document }));
      try {
        NodeAssert.equal(calls.acquire.length, 1);
        NodeAssert.equal(slot.lease, null);
        NodeAssert.equal(slot.denial.reason, "host-unavailable");
        NodeAssert.equal(dom.timeouts.size, 1);
        // The host recovers before the first retry — the slot acquires and
        // presents without a remount or identity change.
        denied = false;
        TestRenderer.act(() => dom.fireTimeouts());
        NodeAssert.equal(calls.acquire.length, 2);
        NodeAssert.equal(slot.lease, lease);
        NodeAssert.equal(slot.denial, null);
        NodeAssert.equal(calls.presents.at(-1).visible, true);
      } finally {
        await TestRenderer.act(async () => renderer.unmount());
      }
      NodeAssert.equal(calls.released, 1);
    } finally {
      dom.restore();
    }
  },
);

NodeTest.test(
  "useBrowserSurfaceSlot stops retrying when the bounded backoff is exhausted",
  async () => {
    const dom = domStubs();
    try {
      const session = makeSession();
      const { host, calls } = fakeLeaseHost();
      host.browserSurface.acquire = (request) => {
        calls.acquire.push(request);
        return {
          ok: false,
          denial: { reason: "host-unavailable", detail: "shell synchronizing" },
        };
      };
      let slot;
      function View() {
        const value = useBrowserSurfaceSlot(host, session, {
          session: sessionRef,
          visible: true,
        });
        React.useEffect(() => {
          slot = value;
        }, [value]);
        return React.createElement("div", { ref: value.ref });
      }
      const renderer = render(View, fakeElement(rect, { document: dom.document }));
      try {
        let rounds = 0;
        while (dom.timeouts.size > 0 && rounds < 20) {
          rounds += 1;
          TestRenderer.act(() => dom.fireTimeouts());
        }
        // 1 initial attempt + 5 bounded retries, then the denial is terminal.
        NodeAssert.equal(calls.acquire.length, 6);
        NodeAssert.equal(dom.timeouts.size, 0);
        NodeAssert.equal(slot.lease, null);
        NodeAssert.equal(slot.denial.reason, "host-unavailable");
      } finally {
        await TestRenderer.act(async () => renderer.unmount());
      }
    } finally {
      dom.restore();
    }
  },
);
