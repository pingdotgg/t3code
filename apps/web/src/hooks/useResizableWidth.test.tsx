import { useEffect } from "react";
import { act } from "react";
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
 * Minimal CSSOM stand-in for `document.body.style`. Mirrors the real mapping
 * between the camelCase property and the dashed name `removeProperty` takes,
 * so a cleanup that removes the wrong name shows up as a leak here too.
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
    getPropertyValue(name: string) {
      return declarations.get(name) ?? "";
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

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

function installTestDom() {
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
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", TestNode);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return document;
}

/** Stand-in for the resize handle element, tracking its pointer capture. */
function createHandleElement() {
  let capturedPointerId: number | null = null;
  return {
    setPointerCapture(pointerId: number) {
      capturedPointerId = pointerId;
    },
    hasPointerCapture(pointerId: number) {
      return capturedPointerId === pointerId;
    },
    releasePointerCapture(pointerId: number) {
      if (capturedPointerId === pointerId) capturedPointerId = null;
    },
    get capturedPointerId() {
      return capturedPointerId;
    },
  };
}

function pointerEvent(
  handle: ReturnType<typeof createHandleElement>,
  overrides: { pointerId?: number; clientX?: number; button?: number } = {},
) {
  return {
    button: overrides.button ?? 0,
    pointerId: overrides.pointerId ?? 1,
    clientX: overrides.clientX ?? 0,
    currentTarget: handle,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as Parameters<ResizableWidthHandlers["onPointerDown"]>[0];
}

function Probe(props: { onHandlers: (handlers: ResizableWidthHandlers) => void }) {
  const { handlers } = useResizableWidth(OPTIONS);
  useEffect(() => {
    props.onHandlers(handlers);
  }, [handlers, props]);
  return null;
}

async function mountProbe(document: TestNode) {
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.createElement("div") as unknown as Element);
  let handlers: ResizableWidthHandlers | null = null;
  await act(() => {
    root.render(
      <Probe
        onHandlers={(next) => {
          handlers = next;
        }}
      />,
    );
  });
  if (handlers === null) throw new Error("handlers were never published");
  return { root, handlers: handlers as ResizableWidthHandlers };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useResizableWidth global cursor state", () => {
  it("clears the global cursor when the drag ends with a pointer up", async () => {
    const document = installTestDom();
    const handle = createHandleElement();
    const { root, handlers } = await mountProbe(document);

    try {
      await act(() => {
        handlers.onPointerDown(pointerEvent(handle, { clientX: 800 }));
      });
      expect(document.body.style.cursor).toBe("col-resize");
      expect(document.body.style.userSelect).toBe("none");

      await act(() => {
        handlers.onPointerUp(pointerEvent(handle, { clientX: 760 }));
      });

      expect(document.body.style.cursor).toBe("");
      expect(document.body.style.userSelect).toBe("");
      expect(handle.capturedPointerId).toBeNull();
    } finally {
      await act(() => root.unmount());
    }
  });

  it("clears the global cursor when the handle unmounts mid-drag", async () => {
    const document = installTestDom();
    const handle = createHandleElement();
    const { root, handlers } = await mountProbe(document);

    await act(() => {
      handlers.onPointerDown(pointerEvent(handle, { clientX: 800 }));
    });
    expect(document.body.style.cursor).toBe("col-resize");

    // The panel can disappear under an in-flight drag: maximizing the right
    // panel, switching it out of inline mode, or closing it all unmount the
    // handle. No further pointer event can reach a handler after that, so the
    // hook itself has to give the body its cursor back.
    await act(() => root.unmount());

    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(handle.capturedPointerId).toBeNull();
  });
});
