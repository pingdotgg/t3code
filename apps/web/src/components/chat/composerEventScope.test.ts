import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  isInsideComposerFocusScope,
  isInsideCollapsedComposerControls,
  isInsideComposerFloatingLayer,
  isInsideRestingComposerControlScope,
  resolveDesktopComposerFocus,
} from "./composerEventScope";

class FakeElement {
  constructor(private readonly matchingSelector: string | null) {}

  closest(selector: string): FakeElement | null {
    return this.matchingSelector !== null &&
      selector.split(",").some((candidate) => candidate === this.matchingSelector)
      ? this
      : null;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("composer event scopes", () => {
  it("recognizes events from the portaled resting controls", () => {
    vi.stubGlobal("Element", FakeElement);

    const target = new FakeElement('[data-chat-composer-resting-controls="true"]');
    expect(isInsideRestingComposerControlScope(target as unknown as EventTarget)).toBe(true);
  });

  it("recognizes events from the composer context strip controls", () => {
    vi.stubGlobal("Element", FakeElement);

    const target = new FakeElement("[data-composer-context-control]");
    expect(isInsideRestingComposerControlScope(target as unknown as EventTarget)).toBe(true);
  });

  it("keeps resting image previews focused without expanding their subtree", () => {
    vi.stubGlobal("Element", FakeElement);

    const target = new FakeElement('[data-chat-composer-resting-images="true"]');
    expect(isInsideRestingComposerControlScope(target as unknown as EventTarget)).toBe(true);
  });

  it("includes composer-owned floating layers in the resting control scope", () => {
    vi.stubGlobal("Element", FakeElement);

    const target = new FakeElement('[data-chat-composer-floating-layer="true"]');
    expect(isInsideComposerFloatingLayer(target as unknown as EventTarget)).toBe(true);
    expect(isInsideRestingComposerControlScope(target as unknown as EventTarget)).toBe(true);
  });

  it("keeps composer-owned toolbar controls and popups in its focus scope", () => {
    vi.stubGlobal("Element", FakeElement);

    const toolbarTarget = new FakeElement('[data-chat-composer-focus-scope="true"]');
    const popupTarget = new FakeElement('[data-chat-composer-floating-layer="true"]');
    expect(isInsideComposerFocusScope(toolbarTarget as unknown as EventTarget)).toBe(true);
    expect(isInsideComposerFocusScope(popupTarget as unknown as EventTarget)).toBe(true);
  });

  it("keeps an expanded composer steady across the branch picker focus transition", () => {
    vi.stubGlobal("Element", FakeElement);
    vi.stubGlobal("Node", FakeElement);

    const trigger = new FakeElement('[data-chat-composer-focus-scope="true"]');
    const searchInput = new FakeElement('[data-chat-composer-floating-layer="true"]');
    let focused = true;

    focused = resolveDesktopComposerFocus({
      currentFocused: focused,
      composerForm: null,
      target: trigger as unknown as EventTarget,
    });
    focused = resolveDesktopComposerFocus({
      currentFocused: focused,
      composerForm: null,
      target: searchInput as unknown as EventTarget,
    });

    expect(focused).toBe(true);
  });

  it("does not expand a resting composer when the branch picker takes focus", () => {
    vi.stubGlobal("Element", FakeElement);
    vi.stubGlobal("Node", FakeElement);

    const trigger = new FakeElement('[data-chat-composer-focus-scope="true"]');
    expect(
      resolveDesktopComposerFocus({
        currentFocused: false,
        composerForm: null,
        target: trigger as unknown as EventTarget,
      }),
    ).toBe(false);
  });

  it("leaves unrelated floating layers outside the composer scope", () => {
    vi.stubGlobal("Element", FakeElement);

    const target = new FakeElement('[data-slot="popover-popup"]');
    expect(isInsideComposerFloatingLayer(target as unknown as EventTarget)).toBe(false);
    expect(isInsideComposerFocusScope(target as unknown as EventTarget)).toBe(false);
    expect(isInsideRestingComposerControlScope(target as unknown as EventTarget)).toBe(false);
  });

  it("leaves ordinary composer targets outside the portaled control scope", () => {
    vi.stubGlobal("Element", FakeElement);

    const target = new FakeElement(null);
    expect(isInsideRestingComposerControlScope(target as unknown as EventTarget)).toBe(false);
    expect(isInsideRestingComposerControlScope(null)).toBe(false);
  });

  it("recognizes banner and drawer controls docked above the surface", () => {
    vi.stubGlobal("Element", FakeElement);

    const target = new FakeElement('[data-chat-composer-collapsed-controls="true"]');
    expect(isInsideCollapsedComposerControls(target as unknown as EventTarget)).toBe(true);
    expect(isInsideCollapsedComposerControls(new FakeElement(null) as unknown as EventTarget)).toBe(
      false,
    );
    expect(isInsideCollapsedComposerControls(null)).toBe(false);
  });
});
