import { act, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  useResizableWidth,
  type ResizableWidthHandlers,
  type UseResizableWidthOptions,
} from "./useResizableWidth";

const OPTIONS: UseResizableWidthOptions = {
  storageKey: "t3code:test-panel-width",
  defaultWidth: 540,
  minWidth: 360,
  maxWidth: 900,
  edge: "left",
};

/**
 * Minimal CSSOM stand-in for `document.body.style`, mirroring the real mapping
 * between the camelCase property and the dashed name `removeProperty` takes.
 */
function createBodyStyle() {
  const declarations = new Map<string, string>();
  return {
    get cursor() {
      return declarations.get("cursor") ?? "";
    },
    set cursor(value: string) {
      declarations.set("cursor", value);
    },
    get userSelect() {
      return declarations.get("user-select") ?? "";
    },
    set userSelect(value: string) {
      declarations.set("user-select", value);
    },
    removeProperty(name: string) {
      const previous = declarations.get(name) ?? "";
      declarations.delete(name);
      return previous;
    },
  };
}

// ReactDOM needs a host tree; this suite intentionally has no DOM dependency.
class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  capturedPointerId: number | null = null;
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  set textContent(_value: string) {
    this.childNodes = [];
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  setPointerCapture(pointerId: number) {
    this.capturedPointerId = pointerId;
  }

  hasPointerCapture(pointerId: number) {
    return this.capturedPointerId === pointerId;
  }

  releasePointerCapture(pointerId: number) {
    if (this.capturedPointerId === pointerId) this.capturedPointerId = null;
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

function pointerEvent(handle: TestNode, clientX: number, pointerId = 1) {
  return {
    button: 0,
    pointerId,
    clientX,
    currentTarget: handle,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as Parameters<ResizableWidthHandlers["onPointerDown"]>[0];
}

function Probe(props: {
  handleMounted: boolean;
  onHandlers: (handlers: ResizableWidthHandlers) => void;
}) {
  const { handlers } = useResizableWidth(OPTIONS);
  useEffect(() => {
    props.onHandlers(handlers);
  }, [handlers, props]);
  return props.handleMounted ? <div {...handlers} /> : null;
}

/**
 * Mounts the hook behind a drag handle that can be removed independently of
 * the hook, mirroring `PreviewPanelShell`: the shell owns the hook and renders
 * the handle only while the panel is inline and not maximized.
 */
async function mountProbe() {
  const document = new TestNode("#document", null, 9) as TestNode & {
    body: { style: ReturnType<typeof createBodyStyle> };
  };
  document.body = { style: createBodyStyle() };
  const window = {
    document,
    HTMLIFrameElement: TestNode,
    addEventListener() {},
    removeEventListener() {},
  };
  Object.assign(document, { defaultView: window, activeElement: null });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", TestNode);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});

  const container = document.createElement("div");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  let handlers: ResizableWidthHandlers | null = null;

  const render = async (handleMounted: boolean) => {
    await act(() => {
      root.render(
        <Probe
          handleMounted={handleMounted}
          onHandlers={(next) => {
            handlers = next;
          }}
        />,
      );
    });
  };

  await render(true);
  const handle = container.childNodes[0];
  if (!handle) throw new Error("the drag handle was never rendered");
  if (handlers === null) throw new Error("handlers were never published");

  return {
    body: document.body,
    handle,
    handlers: handlers as ResizableWidthHandlers,
    unmountHandle: () => render(false),
    unmountAll: () => act(() => root.unmount()),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useResizableWidth global cursor state", () => {
  it("clears the global cursor when the drag ends with a pointer up", async () => {
    const probe = await mountProbe();

    await act(() => {
      probe.handlers.onPointerDown(pointerEvent(probe.handle, 800));
    });
    expect(probe.body.style.cursor).toBe("col-resize");
    expect(probe.body.style.userSelect).toBe("none");

    await act(() => {
      probe.handlers.onPointerUp(pointerEvent(probe.handle, 760));
    });

    expect(probe.body.style.cursor).toBe("");
    expect(probe.body.style.userSelect).toBe("");
    expect(probe.handle.capturedPointerId).toBeNull();

    await probe.unmountAll();
  });

  it("clears the global cursor when the handle is removed mid-drag", async () => {
    const probe = await mountProbe();

    await act(() => {
      probe.handlers.onPointerDown(pointerEvent(probe.handle, 800));
    });
    expect(probe.body.style.cursor).toBe("col-resize");

    await probe.unmountHandle();

    expect(probe.body.style.cursor).toBe("");
    expect(probe.body.style.userSelect).toBe("");
    expect(probe.handle.capturedPointerId).toBeNull();

    await probe.unmountAll();
  });

  it("clears the global cursor when the whole panel unmounts mid-drag", async () => {
    const probe = await mountProbe();

    await act(() => {
      probe.handlers.onPointerDown(pointerEvent(probe.handle, 800));
    });
    expect(probe.body.style.cursor).toBe("col-resize");

    await probe.unmountAll();

    expect(probe.body.style.cursor).toBe("");
    expect(probe.body.style.userSelect).toBe("");
    expect(probe.handle.capturedPointerId).toBeNull();
  });
});
