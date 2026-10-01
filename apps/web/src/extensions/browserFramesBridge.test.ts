import { describe, it, expect, beforeAll } from "vite-plus/test";
import { BROWSER_FRAMES, BROWSER_SESSIONS } from "@t3tools/extension-sdk/catalogue";

import type {
  BrowserFrameClient,
  BrowserFrameEvents,
  BrowserFrameTarget,
} from "@t3tools/client-runtime/browser-frames/stream";

import {
  createBrowserFramesBridge,
  type BrowserFramesBinding,
  type BrowserFramesBridgeDeps,
} from "./browserFramesBridge";

const context = {
  client: "web",
  resource: {
    namespace: "test.plugin",
    id: "view",
    environmentId: "env-a",
    projectId: "project-a",
    threadId: "thread-a",
  },
};
const sessionRef = { tabId: "tab-1", serverEpoch: "epoch-1" };

/**
 * The bridge mounts a real element tree; tests run under Node, so a minimal
 * stand-in covers the DOM surface the presenter touches.
 */
class FakeElement {
  static documentOf(owner: FakeElement) {
    return {
      createElement: (tag: string) => new FakeElement(tag),
      defaultView: {},
    };
  }
  readonly tagName: string;
  readonly ownerDocument = FakeElement.documentOf(this);
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  style = { cssText: "" };
  tabIndex = -1;
  parent: FakeElement | null = null;
  focused = false;
  rect = { left: 0, top: 0, width: 400, height: 300 };
  constructor(tag = "div") {
    this.tagName = tag;
  }
  setAttribute() {}
  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  replaceChild(next: FakeElement, previous: FakeElement) {
    const index = this.children.indexOf(previous);
    if (index >= 0) this.children.splice(index, 1, next);
    next.parent = this;
    previous.parent = null;
    return previous;
  }
  remove() {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, event: Record<string, unknown>) {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") listener(event as unknown as Event);
      else listener.handleEvent(event as unknown as Event);
    }
  }
  focus() {
    this.focused = true;
  }
  setPointerCapture() {}
  getBoundingClientRect() {
    return {
      ...this.rect,
      right: this.rect.left + this.rect.width,
      bottom: this.rect.top + this.rect.height,
      x: this.rect.left,
      y: this.rect.top,
      toJSON: () => ({}),
    };
  }
}

interface FakeClient extends BrowserFrameClient {
  calls: { method: string; args: unknown[] }[];
  started: number;
  stopped: number;
  record(method: string, args: unknown[]): void;
}

beforeAll(() => {
  (globalThis as Record<string, unknown>).HTMLElement = FakeElement;
});

function harness() {
  const lifetime = new AbortController();
  const grants = {
    capabilities: [BROWSER_SESSIONS, BROWSER_FRAMES] as string[],
    projectIds: ["project-a"] as string[],
  };
  const binding: BrowserFramesBinding = {
    grants,
    lifetime: lifetime.signal,
  };
  const events: { current: BrowserFrameEvents | null } = { current: null };
  const targets: BrowserFrameTarget[] = [];
  const clients: FakeClient[] = [];
  const scheduled = new Set<() => void>();
  const endpoint = { url: "http://env.test:13773/" as string | null };
  const deps: BrowserFramesBridgeDeps = {
    httpBaseUrl: () => endpoint.url,
    createClient: (target, clientEvents) => {
      targets.push(target);
      events.current = clientEvents;
      const client: FakeClient = {
        calls: [],
        started: 0,
        stopped: 0,
        record(method, args) {
          client.calls.push({ method, args });
        },
        start() {
          client.started += 1;
          client.record("start", []);
        },
        stop() {
          client.stopped += 1;
          client.record("stop", []);
        },
        setSurface: (surface) => client.record("setSurface", [surface]),
        state: () => ({
          status: "connecting",
          config: null,
          geometrySeq: 0,
          droppedFrames: 0,
          inputConnected: false,
        }),
        sendPointer: (...args) => client.record("sendPointer", args),
        sendWheel: (...args) => client.record("sendWheel", args),
        sendKey: (...args) => client.record("sendKey", args),
        sendText: (...args) => client.record("sendText", args),
      };
      clients.push(client);
      return client;
    },
    schedule: (flush) => {
      scheduled.add(flush);
      return () => scheduled.delete(flush);
    },
  };
  const host = createBrowserFramesBridge("env-a", deps)(binding);
  return { host, binding, grants, lifetime, deps, endpoint, events, targets, clients, scheduled };
}

const mint = { ticket: "bfv1.st.ticket", expiresAt: Date.now() + 60_000 };
const present = (
  host: ReturnType<typeof harness>["host"],
  overrides: Record<string, unknown> = {},
) =>
  host.present({
    context,
    session: sessionRef,
    slot: new FakeElement() as unknown as HTMLElement,
    openStream: async () => mint,
    openInput: async () => ({
      leaseId: "bfli.1",
      inputTicket: "bfv1.in.ticket",
      expiresAt: Date.now() + 60_000,
    }),
    ...overrides,
  } as Parameters<typeof host.present>[0]);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("browserFramesBridge", () => {
  it("denies presentation without the required installation grants", async () => {
    const { host, grants } = harness();
    grants.capabilities.length = 0;
    const result = present(host);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.denial.reason).toBe("grant-denied");
      expect(result.denial.grant).toBe(BROWSER_SESSIONS);
    }
  });

  it("denies a context outside this environment", () => {
    const { host } = harness();
    const result = present(host, {
      context: { ...context, resource: { ...context.resource, environmentId: "env-other" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denial.reason).toBe("scope-invalid");
  });

  it("reports host-unavailable when the environment has no resolved endpoint", () => {
    const { host, endpoint } = harness();
    endpoint.url = null;
    const result = present(host);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denial.reason).toBe("host-unavailable");
  });

  it("mounts a frame element, mints the ticket, and starts the transport", async () => {
    const { host, targets, clients } = harness();
    const slot = new FakeElement();
    const result = present(host, { slot: slot as unknown as HTMLElement });
    expect(result.ok).toBe(true);
    await flush();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.session.tabId).toBe("tab-1");
    expect(targets[0]?.session.serverEpoch).toBe("epoch-1");
    expect(targets[0]?.session.environmentId).toBe("env-a");
    expect(targets[0]?.frameTicket).toBe("bfv1.st.ticket");
    expect(targets[0]?.access.httpBase).toBe("http://env.test:13773/api/browser-frames");
    expect(targets[0]?.access.wsBase).toBe("ws://env.test:13773/api/browser-frames");
    expect(clients[0]?.started).toBe(1);
    // Wrapper + canvas mounted inside the caller's slot.
    expect(slot.children).toHaveLength(1);
    expect(slot.children[0]?.children).toHaveLength(1);
  });

  it("normalizes pointer and wheel input against the painted frame", async () => {
    const { host, clients } = harness();
    const slot = new FakeElement();
    present(host, { slot: slot as unknown as HTMLElement });
    await flush();
    const wrapper = slot.children[0]!;
    wrapper.dispatch("pointerdown", {
      pointerId: 1,
      button: 0,
      clientX: 200,
      clientY: 150,
    });
    wrapper.dispatch("wheel", {
      clientX: 100,
      clientY: 75,
      deltaX: 5,
      deltaY: -40,
      preventDefault: () => {},
    });
    const calls = clients[0]!.calls;
    expect(calls).toContainEqual({ method: "sendPointer", args: ["down", 0.5, 0.5, "left"] });
    expect(calls).toContainEqual({ method: "sendWheel", args: [5, -40, 0.25, 0.25] });
  });

  it("forwards keys with modifiers and single-char text", async () => {
    const { host, clients } = harness();
    const slot = new FakeElement();
    present(host, { slot: slot as unknown as HTMLElement });
    await flush();
    const wrapper = slot.children[0]!;
    wrapper.dispatch("keydown", {
      key: "a",
      code: "KeyA",
      metaKey: false,
      ctrlKey: false,
      getModifierState: (name: string) => name === "Shift",
      preventDefault: () => {},
    });
    wrapper.dispatch("keyup", {
      key: "a",
      code: "KeyA",
      metaKey: false,
      getModifierState: () => false,
      preventDefault: () => {},
    });
    const calls = clients[0]!.calls;
    expect(calls).toContainEqual({
      method: "sendKey",
      args: ["down", { key: "a", code: "KeyA", text: "a", modifiers: ["Shift"] }],
    });
    expect(calls).toContainEqual({
      method: "sendKey",
      args: ["up", { key: "a", code: "KeyA", modifiers: [] }],
    });
  });

  it("keeps host-reserved meta combos local", async () => {
    const { host, clients } = harness();
    const slot = new FakeElement();
    present(host, { slot: slot as unknown as HTMLElement });
    await flush();
    const wrapper = slot.children[0]!;
    wrapper.dispatch("keydown", {
      key: "w",
      code: "KeyW",
      metaKey: true,
      getModifierState: (name: string) => name === "Meta",
      preventDefault: () => {},
    });
    expect(clients[0]!.calls.filter((call) => call.method === "sendKey")).toHaveLength(0);
  });

  it("re-mints the stream ticket on unauthorized and restarts", async () => {
    const { host, clients, events, targets } = harness();
    const slot = new FakeElement();
    const tickets = ["bfv1.st.first", "bfv1.st.second"];
    let index = 0;
    present(host, {
      slot: slot as unknown as HTMLElement,
      openStream: async () => ({ ticket: tickets[index++]!, expiresAt: Date.now() + 60_000 }),
    });
    await flush();
    events.current?.onUnauthorized();
    await flush();
    expect(targets[0]?.frameTicket).toBe("bfv1.st.second");
    expect(clients[0]?.started).toBe(2);
  });

  it("detaches the view: stops the client and removes the mounted element", async () => {
    const { host, clients } = harness();
    const slot = new FakeElement();
    const result = present(host, { slot: slot as unknown as HTMLElement });
    await flush();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.view.detach();
    expect(clients[0]?.stopped).toBe(1);
    expect(slot.children).toHaveLength(0);
    result.view.detach();
    expect(clients[0]?.stopped).toBe(1);
  });
});
