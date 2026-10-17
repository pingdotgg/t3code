import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerHandleContext, type ComposerHandleRef } from "../../composerHandleContext";
import {
  isInsideCollapsedComposerControls,
  isInsideComposerFloatingLayer,
  isInsideRestingComposerControlScope,
  useComposerMenuProps,
} from "./composerEventScope";

function elementInside(html: string) {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host.querySelector("[data-target]")!;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("composer menu focus", () => {
  it.each([
    [
      "an open menu",
      '<div data-chat-composer-floating-layer="true"><button data-target></button></div>',
      true,
    ],
    ["an unmounted menu", null, true],
    ["another control", "<input data-target />", false],
  ])("closes while focus is on %s", async (_label, html, shouldFocusComposer) => {
    const editor = document.createElement("textarea");
    document.body.append(editor);
    const focused = html === null ? null : (elementInside(html) as HTMLElement);
    focused?.focus();
    const composerRef = {
      current: { focusAtEnd: () => editor.focus() },
    } as unknown as ComposerHandleRef;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let menuProps: ReturnType<typeof useComposerMenuProps> | undefined;
    function Probe() {
      const props = useComposerMenuProps();
      useLayoutEffect(() => {
        menuProps = props;
      }, [props]);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () =>
      root.render(
        <ComposerHandleContext value={composerRef}>
          <Probe />
        </ComposerHandleContext>,
      ),
    );
    try {
      expect(menuProps?.finalFocus?.()).toBe(false);
      expect(document.activeElement).toBe(shouldFocusComposer ? editor : focused);
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("composer event scopes", () => {
  it.each([
    '<div data-chat-composer-resting-controls="true"><button data-target></button></div>',
    "<div data-composer-context-control><button data-target></button></div>",
    '<div data-chat-composer-resting-images="true"><img data-target /></div>',
  ])("recognizes events from resting composer controls in %s", (html) => {
    expect(isInsideRestingComposerControlScope(elementInside(html))).toBe(true);
  });

  it("includes composer-owned floating layers in the resting control scope", () => {
    const target = elementInside(
      '<div data-chat-composer-floating-layer="true"><button data-target></button></div>',
    );
    expect(isInsideComposerFloatingLayer(target)).toBe(true);
    expect(isInsideRestingComposerControlScope(target)).toBe(true);
  });

  it("leaves unrelated floating layers outside the composer scope", () => {
    const target = elementInside(
      '<div data-slot="popover-popup"><button data-target></button></div>',
    );
    expect(isInsideComposerFloatingLayer(target)).toBe(false);
    expect(isInsideRestingComposerControlScope(target)).toBe(false);
  });

  it("leaves ordinary composer targets outside the portaled control scope", () => {
    expect(
      isInsideRestingComposerControlScope(elementInside("<button data-target></button>")),
    ).toBe(false);
    expect(isInsideRestingComposerControlScope(null)).toBe(false);
  });

  it("recognizes banner and drawer controls docked above the surface", () => {
    const target = elementInside(
      '<div data-chat-composer-collapsed-controls="true"><button data-target></button></div>',
    );
    expect(isInsideCollapsedComposerControls(target)).toBe(true);
    expect(isInsideCollapsedComposerControls(elementInside("<span data-target></span>"))).toBe(
      false,
    );
    expect(isInsideCollapsedComposerControls(null)).toBe(false);
  });
});
