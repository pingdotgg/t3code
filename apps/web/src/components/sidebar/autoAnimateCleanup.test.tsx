import type { AnimationController } from "@formkit/auto-animate";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Run the installed library with controlled browser scheduling. Layout and frame
// timings are covered by the real-client sidebar performance recording.
class TestElement {
  readonly nodeName = "DIV";
  readonly style = {};
  readonly offsetWidth = 1000;
  readonly offsetHeight = 1000;
  readonly clientWidth = 1000;
  readonly clientHeight = 1000;
  parentElement: TestElement | null = null;
  isConnected = true;
  private childNodes: TestElement[] = [];
  get children() {
    return Object.assign(this.childNodes, {
      item: (index: number) => this.childNodes[index] ?? null,
    });
  }
  get parentNode() {
    return this.parentElement;
  }
  getBoundingClientRect = vi.fn(() => ({
    top: 0,
    left: 0,
    right: 100,
    bottom: 20,
    width: 100,
    height: 20,
  }));
  appendChild(child: TestElement) {
    child.parentElement = this;
    child.isConnected = this.isConnected;
    this.childNodes.push(child);
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.childNodes = this.parentElement.childNodes.filter((node) => node !== this);
    }
    this.parentElement = null;
    this.isConnected = false;
  }
  animate = vi.fn(() => {
    const listeners: Array<() => void> = [];
    let finishAnimation!: () => void;
    const finished = new Promise<void>((resolve) => {
      finishAnimation = resolve;
    });
    return {
      finished,
      playState: "running",
      cancel: vi.fn(),
      addEventListener: (_event: string, listener: () => void) => listeners.push(listener),
      finish: () => {
        finishAnimation();
        listeners.forEach((listener) => listener());
      },
    };
  });
}

class TestObserver {
  static instances: TestObserver[] = [];
  readonly observed = new Set<TestElement>();
  records: MutationRecord[] = [];
  constructor(readonly callback: (records: MutationRecord[]) => void) {
    TestObserver.instances.push(this);
  }
  observe(node: TestElement) {
    this.observed.add(node);
  }
  unobserve(node: TestElement) {
    this.observed.delete(node);
  }
  disconnect() {
    this.observed.clear();
    this.records = [];
  }
  takeRecords() {
    const records = this.records;
    this.records = [];
    return records;
  }
}

let parent: TestElement;
let root: TestElement;
let idleCallbacks: Array<() => void>;
let controllers: AnimationController[];
let renderer: ReactTestRenderer | null;
let moduleInstance = 0;
const libraryUrl = NodeURL.pathToFileURL(
  NodeModule.createRequire(import.meta.url).resolve("@formkit/auto-animate"),
);
let library: typeof import("@formkit/auto-animate") | undefined;

function queueRemoval(child: TestElement) {
  const record = {
    target: parent,
    addedNodes: [],
    removedNodes: [child],
    previousSibling: null,
    nextSibling: null,
  } as unknown as MutationRecord;
  child.remove();
  // The parent mutation observer is the one observing only the list.
  const observer = TestObserver.instances.find(
    (item) => item.observed.has(parent) && item.observed.size === 1,
  )!;
  observer.records.push(record);
  return observer;
}

async function start(node = parent) {
  // External ESM imports survive vi.resetModules; each case needs fresh browser globals.
  library ??= (await import(
    /* @vite-ignore */ `${libraryUrl.href}?cleanup-test=${moduleInstance++}`
  )) as typeof import("@formkit/auto-animate");
  const controller = library.autoAnimate(node as unknown as HTMLElement);
  controllers.push(controller);
  return controller;
}

function expectStopped() {
  expect(vi.getTimerCount()).toBe(0);
  expect(TestObserver.instances.flatMap((observer) => [...observer.observed])).toEqual([root]);
}

beforeEach(() => {
  vi.resetModules();
  library = undefined;
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);
  TestObserver.instances = [];
  parent = new TestElement();
  root = new TestElement();
  idleCallbacks = [];
  controllers = [];
  renderer = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Element", TestElement);
  vi.stubGlobal("HTMLElement", TestElement);
  vi.stubGlobal(
    "HTMLBodyElement",
    class {
      readonly nodeName = "BODY";
    },
  );
  vi.stubGlobal("window", {
    ResizeObserver: TestObserver,
    addEventListener() {},
    matchMedia: () => ({ matches: false }),
    scrollX: 0,
    scrollY: 0,
  });
  vi.stubGlobal("document", { documentElement: root, body: root });
  vi.stubGlobal("ResizeObserver", TestObserver);
  vi.stubGlobal("MutationObserver", TestObserver);
  vi.stubGlobal("IntersectionObserver", TestObserver);
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => idleCallbacks.push(callback));
  vi.stubGlobal("getComputedStyle", () => ({
    position: "relative",
    boxSizing: "content-box",
    borderTopWidth: "0px",
    borderLeftWidth: "0px",
    getPropertyValue: () => "0px",
  }));
});

afterEach(() => {
  act(() => renderer?.unmount());
  controllers.forEach((controller) => controller.destroy?.());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AutoAnimate controller cleanup", () => {
  it("cancels delayed polling when destroyed before its staggered start", async () => {
    parent.appendChild(new TestElement());
    const controller = await start();
    controller.destroy?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expectStopped();
    expect(parent.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it("tears down running intervals and position observers", async () => {
    parent.appendChild(new TestElement());
    const controller = await start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(vi.getTimerCount()).toBe(2);
    expect(parent.getBoundingClientRect).toHaveBeenCalled();
    controller.destroy?.();
    expectStopped();
  });

  it("ignores an old polling callback after destroy and recreation", async () => {
    const controller = await start();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(idleCallbacks).toHaveLength(1);
    controller.destroy?.();
    const next = await start();
    await vi.advanceTimersByTimeAsync(250);
    expect(vi.getTimerCount()).toBe(1);
    idleCallbacks.splice(0).forEach((callback) => callback());
    expect(vi.getTimerCount()).toBe(1);
    next.destroy?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expectStopped();
  });

  it("ignores queued root-resize work after destroying its parent", async () => {
    const controller = await start();
    await vi.advanceTimersByTimeAsync(250);
    const resize = TestObserver.instances.find((observer) => observer.observed.has(root))!;
    resize.callback([{ target: root } as unknown as MutationRecord]);
    await vi.advanceTimersByTimeAsync(100);
    expect(idleCallbacks).toHaveLength(1);
    controller.destroy?.();
    idleCallbacks.splice(0).forEach((callback) => callback());
    await vi.advanceTimersByTimeAsync(10_000);
    expectStopped();
  });

  it("ignores queued root-resize work after recreating the same parent", async () => {
    const controller = await start();
    await vi.advanceTimersByTimeAsync(250);
    const resize = TestObserver.instances.find((observer) => observer.observed.has(root))!;
    resize.callback([{ target: root } as unknown as MutationRecord]);
    await vi.advanceTimersByTimeAsync(100);
    expect(idleCallbacks).toHaveLength(1);
    controller.destroy?.();
    const next = await start();
    await vi.advanceTimersByTimeAsync(250);
    expect(vi.getTimerCount()).toBe(1);
    idleCallbacks.splice(0).forEach((callback) => callback());
    expect(vi.getTimerCount()).toBe(1);
    next.destroy?.();
    expectStopped();
  });

  it("does not restore observers from an already-running position update", async () => {
    const controller = await start();
    // Fire the debounce without flushing its awaited continuation.
    vi.advanceTimersByTime(250);
    controller.destroy?.();
    await Promise.resolve();
    expectStopped();
  });

  it("cleans removed children before mutation observer delivery", async () => {
    const child = new TestElement();
    parent.appendChild(child);
    const controller = await start();
    await vi.advanceTimersByTimeAsync(2_000);
    queueRemoval(child);
    controller.destroy?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expectStopped();
  });

  it("stops tracking a child after its removal animation finishes", async () => {
    const child = new TestElement();
    parent.appendChild(child);
    const controller = await start();
    await vi.advanceTimersByTimeAsync(2_000);
    const observer = queueRemoval(child);
    observer.callback(observer.takeRecords());
    child.animate.mock.results[0]!.value.finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(TestObserver.instances.some((item) => item.observed.has(child))).toBe(false);
    controller.destroy?.();
    expectStopped();
  });

  it("can repeatedly destroy and recreate without accumulating work", async () => {
    for (let cycle = 0; cycle < 5; cycle++) {
      const controller = await start();
      await vi.advanceTimersByTimeAsync(cycle % 2 === 0 ? 100 : 2_000);
      controller.destroy?.();
      controller.destroy?.();
      expectStopped();
    }
  });

  it("preserves a moved child's live registration in another animated parent", async () => {
    const child = new TestElement();
    parent.appendChild(child);
    const first = await start();
    const destination = new TestElement();
    const second = await start(destination);
    await vi.advanceTimersByTimeAsync(2_000);
    queueRemoval(child);
    destination.appendChild(child);
    const observer = TestObserver.instances.find(
      (item) => item.observed.has(destination) && item.observed.size === 1,
    )!;
    observer.callback([
      { target: destination, addedNodes: [child], removedNodes: [] } as unknown as MutationRecord,
    ]);
    child.animate.mock.results[0]!.value.finish();
    destination.animate.mock.results[0]!.value.finish();
    await vi.advanceTimersByTimeAsync(1);
    const tracking = TestObserver.instances.filter((item) => item.observed.has(child));
    expect(tracking).toHaveLength(2);
    first.destroy?.();
    expect(tracking.every((item) => item.observed.has(child))).toBe(true);
    expect(vi.getTimerCount()).toBe(2);
    second.destroy?.();
    expectStopped();
  });

  it("does not resume observing a removed child from queued root-resize work", async () => {
    const child = new TestElement();
    parent.appendChild(child);
    const controller = await start();
    await vi.advanceTimersByTimeAsync(250);
    const resize = TestObserver.instances.find((observer) => observer.observed.has(root))!;
    resize.callback([{ target: root } as unknown as MutationRecord]);
    await vi.advanceTimersByTimeAsync(100);
    expect(idleCallbacks).toHaveLength(2);
    const observer = queueRemoval(child);
    observer.callback(observer.takeRecords());
    child.animate.mock.results[0]!.value.finish();
    parent.animate.mock.results[0]!.value.finish();
    await vi.advanceTimersByTimeAsync(1);
    idleCallbacks.splice(0).forEach((callback) => callback());
    await vi.advanceTimersByTimeAsync(250);
    expect(TestObserver.instances.some((item) => item.observed.has(child))).toBe(false);
    controller.destroy?.();
    expectStopped();
  });

  it("registers an initially large sidebar only after it becomes small", async () => {
    const { useSidebarThreadListAutoAnimate } = await import("./useSidebarThreadListAutoAnimate");
    function ThreadList({ rowCount }: { rowCount: number }) {
      return <ul ref={useSidebarThreadListAutoAnimate(rowCount)} />;
    }
    act(() => {
      renderer = create(<ThreadList rowCount={101} />, { createNodeMock: () => parent });
    });
    expectStopped();
    act(() => renderer!.update(<ThreadList rowCount={1} />));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(vi.getTimerCount()).toBe(1);
    act(() => renderer!.update(<ThreadList rowCount={101} />));
    expectStopped();
    act(() => renderer!.update(<ThreadList rowCount={1} />));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(vi.getTimerCount()).toBe(1);
    act(() => renderer!.unmount());
    renderer = null;
    expectStopped();
  });

  it("does not initialize browser work during server rendering", async () => {
    vi.stubGlobal("window", undefined);
    const controller = await start();
    controller.destroy?.();
    expect(vi.getTimerCount()).toBe(0);
    expect(TestObserver.instances).toEqual([]);
  });
});
