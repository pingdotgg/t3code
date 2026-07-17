import * as NodeEvents from "node:events";

import { CliRenderEvents, type CliRenderer, type TerminalCapabilities } from "@opentui/core";
import { describe, expect, it } from "bun:test";

import {
  installKittyImageExtension,
  KittyImageManager,
  type KittyImagePatch,
} from "./KittyImageManager.ts";

class FakeRenderer extends NodeEvents.EventEmitter {
  capabilities: TerminalCapabilities | null = null;
  readonly callbacks = new Set<(deltaTime: number) => Promise<void>>();
  renderRequests = 0;

  setFrameCallback(callback: (deltaTime: number) => Promise<void>): void {
    this.callbacks.add(callback);
  }

  removeFrameCallback(callback: (deltaTime: number) => Promise<void>): void {
    this.callbacks.delete(callback);
  }

  requestRender(): void {
    this.renderRequests += 1;
  }
}

const patch = (overrides: Partial<KittyImagePatch> = {}): KittyImagePatch => ({
  key: 1,
  revision: 0,
  x: 2,
  y: 3,
  imageWidth: 1,
  imageHeight: 1,
  sourceX: 0,
  sourceY: 0,
  sourceWidth: 1,
  sourceHeight: 1,
  columns: 1,
  rows: 1,
  data: new Uint8Array([1, 2, 3, 255]),
  ...overrides,
});

function createHarness(capability: "auto" | "always" = "always", tmuxPassthrough = false) {
  const renderer = new FakeRenderer();
  const writes: string[] = [];
  const manager = new KittyImageManager(renderer as unknown as CliRenderer, {
    capability,
    tmuxPassthrough,
    writer: { write: (value) => writes.push(value) },
  });
  return { renderer, manager, writes };
}

describe("KittyImageManager", () => {
  it("transmits once and deduplicates an unchanged frame", () => {
    const { manager, writes } = createHarness();
    manager.beginFrame();
    const first = manager.submit(patch());
    manager.flushFrame();
    manager.beginFrame();
    const second = manager.submit(patch());
    manager.flushFrame();

    expect(first).toMatchObject({ imageId: 1, ready: false });
    expect(second).toMatchObject({ imageId: 1, ready: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("a=T");
  });

  it("deletes the old image before replacing a changed patch", () => {
    const { manager, writes } = createHarness();
    manager.beginFrame();
    manager.submit(patch());
    manager.flushFrame();
    manager.beginFrame();
    manager.submit(patch({ revision: 1 }));
    manager.flushFrame();

    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatch(/a=d,d=i,i=1.*a=T.*i=2/s);
  });

  it("deletes images omitted from the next frame", () => {
    const { manager, writes } = createHarness();
    manager.beginFrame();
    manager.submit(patch());
    manager.flushFrame();
    manager.beginFrame();
    manager.flushFrame();

    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain("a=d,d=i,i=1");
  });

  it("waits for detected Kitty support in auto mode", () => {
    const { renderer, manager, writes } = createHarness("auto");
    manager.beginFrame();
    manager.submit(patch());
    manager.flushFrame();
    expect(writes).toHaveLength(0);

    renderer.capabilities = { kitty_graphics: true } as TerminalCapabilities;
    renderer.emit(CliRenderEvents.CAPABILITIES, renderer.capabilities);
    expect(renderer.renderRequests).toBe(1);
    manager.beginFrame();
    manager.submit(patch());
    manager.flushFrame();
    expect(writes).toHaveLength(1);
  });

  it("uses tmux passthrough when the multiplexer masks outer Kitty support", () => {
    const { renderer, manager, writes } = createHarness("auto", true);
    renderer.capabilities = {
      kitty_graphics: false,
      multiplexer: "tmux",
    } as TerminalCapabilities;

    expect(manager.isSupported).toBe(true);
    manager.beginFrame();
    manager.submit(patch());
    manager.flushFrame();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("\x1bPtmux;\x1b\x1b_Ga=T");
  });

  it("does not assume an unidentified tmux host supports Kitty graphics", () => {
    const { renderer, manager, writes } = createHarness("auto");
    renderer.capabilities = {
      kitty_graphics: false,
      multiplexer: "tmux",
    } as TerminalCapabilities;

    expect(manager.isSupported).toBe(false);
    manager.beginFrame();
    manager.submit(patch());
    manager.flushFrame();
    expect(writes).toHaveLength(0);
  });

  it("applies explicit options when a renderable installed the manager first", () => {
    const renderer = new FakeRenderer();
    const first = installKittyImageExtension(renderer as unknown as CliRenderer);
    const writes: string[] = [];
    const configured = installKittyImageExtension(renderer as unknown as CliRenderer, {
      capability: "always",
      writer: { write: (value) => writes.push(value) },
    });

    expect(configured).toBe(first);
    configured.beginFrame();
    configured.submit(patch());
    configured.flushFrame();
    expect(writes.join("")).toContain("a=T");
  });

  it("cleans active images and detaches hooks on dispose", () => {
    const { renderer, manager, writes } = createHarness();
    manager.beginFrame();
    manager.submit(patch());
    manager.flushFrame();
    manager.dispose();

    expect(writes.at(-1)).toContain("a=d,d=i,i=1");
    expect(renderer.callbacks.size).toBe(0);
    expect(renderer.listenerCount(CliRenderEvents.FRAME)).toBe(0);
    expect(manager.isDisposed).toBe(true);
  });

  it("clears placements without uninstalling the extension", () => {
    const { renderer, manager, writes } = createHarness();
    manager.beginFrame();
    manager.submit(patch());
    manager.flushFrame();
    manager.clearImages();

    expect(writes.at(-1)).toContain("a=d,d=i,i=1");
    expect(renderer.callbacks.size).toBe(1);
    expect(manager.isDisposed).toBe(false);
  });

  it("replaces active placements during scrolling and restores them when scrolling settles", () => {
    const { renderer, manager, writes } = createHarness();
    manager.beginFrame();
    manager.submit(patch());
    manager.flushFrame();

    manager.pauseForScroll(10_000);

    expect(manager.isScrollPaused).toBe(true);
    expect(writes.at(-1)).toContain("a=d,d=i,i=1");
    manager.beginFrame();
    manager.submit(patch());
    manager.flushFrame();
    expect(writes.filter((value) => value.includes("a=T"))).toHaveLength(1);

    manager.resumeAfterScroll();
    manager.beginFrame();
    manager.submit(patch());
    manager.flushFrame();

    expect(manager.isScrollPaused).toBe(false);
    expect(writes.filter((value) => value.includes("a=T"))).toHaveLength(2);
    expect(renderer.renderRequests).toBeGreaterThanOrEqual(2);
  });
});
