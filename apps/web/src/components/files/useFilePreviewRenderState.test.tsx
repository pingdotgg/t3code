import { act, StrictMode, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useFilePreviewRenderState } from "./useFilePreviewRenderState";

let renderer: ReactTestRenderer | null;
let state: ReturnType<typeof useFilePreviewRenderState>;
let storage: Map<string, string>;

function Preview(props: { path: string | null; line: number | null; requestId: number }) {
  const currentState = useFilePreviewRenderState(props.path, props.line, props.requestId);
  useEffect(() => {
    state = currentState;
  });
  return null;
}

function open(path: string | null = "report.html", line: number | null = null, requestId = 0) {
  act(() => {
    const element = (
      <StrictMode>
        <Preview path={path} line={line} requestId={requestId} />
      </StrictMode>
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}

beforeEach(() => {
  renderer = null;
  storage = new Map();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    }),
  );
});

afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("file preview render state", () => {
  it("opens HTML rendered even when an older version saved source mode globally", () => {
    storage.set("t3code.renderBrowserFile", "false");
    open();
    expect(state.htmlRendered && state.revealHandled).toBe(true);
  });

  it("keeps the current source view on rerender but starts each new document rendered", () => {
    open();
    act(() => state.setRendered(false));
    open();
    expect(state.htmlRendered).toBe(false);
    open("second.html");
    expect(state.htmlRendered).toBe(true);
    open();
    expect(state.htmlRendered).toBe(true);
  });

  it("resets source mode after the explorer or a remount", () => {
    open();
    act(() => state.setRendered(false));
    open(null);
    open();
    expect(state.htmlRendered).toBe(true);
    act(() => state.setRendered(false));
    act(() => renderer!.unmount());
    renderer = null;
    open();
    expect(state.htmlRendered).toBe(true);
  });

  it("opens a new line request as source and lets the rendered toggle dismiss it", () => {
    open("report.html", 2, 1);
    expect(state.revealHandled).toBe(false);
    act(() => state.setRendered(true));
    expect(state.htmlRendered && state.revealHandled).toBe(true);
    open("report.html", 3, 2);
    expect(state.revealHandled).toBe(false);
  });

  it("does not reuse a dismissed line request after switching documents", () => {
    open("report.html", 2, 1);
    act(() => state.setRendered(true));
    open("second.html");
    open("report.html", 2, 1);
    expect(state.revealHandled).toBe(false);
  });
});
