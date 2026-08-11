import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

class TestElement extends EventTarget {
  readonly nodeType = 1;
  readonly nodeName = "DIV";
  readonly tagName = "DIV";
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly childNodes: Array<unknown> = [];
  readonly style = {};
  parentNode: TestElement | null = null;

  constructor(readonly ownerDocument: Document) {
    super();
  }

  appendChild(child: TestElement): TestElement {
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  insertBefore(child: TestElement, before: TestElement): TestElement {
    const index = this.childNodes.indexOf(before);
    if (index === -1) return this.appendChild(child);
    this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child: TestElement): TestElement {
    const index = this.childNodes.indexOf(child);
    if (index === -1) {
      throw new DOMException(
        "The node to be removed is not a child of this node.",
        "NotFoundError",
      );
    }
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
}

function replaceGlobal(name: "document" | "window" | "IS_REACT_ACT_ENVIRONMENT", value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
  return () => {
    if (original === undefined) {
      delete (globalThis as Record<string, unknown>)[name];
      return;
    }
    Object.defineProperty(globalThis, name, original);
  };
}

export function installReactHookTestDom() {
  const window = new EventTarget() as unknown as Record<string, unknown>;
  window.window = window;
  window.self = window;
  window.top = window;
  window.HTMLIFrameElement = TestElement;
  const document = new EventTarget() as unknown as Record<string, unknown>;
  document.nodeType = 9;
  document.defaultView = window;
  document.visibilityState = "visible";
  document.createElement = () => new TestElement(document as unknown as Document);
  document.createTextNode = (text: string) => ({ nodeType: 3, nodeValue: text });
  document.documentElement = new TestElement(document as unknown as Document);
  document.activeElement = null;
  const restoreDocument = replaceGlobal("document", document);
  const restoreWindow = replaceGlobal("window", window);
  const restoreActEnvironment = replaceGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const documentView = document as unknown as Document & {
    visibilityState: DocumentVisibilityState;
  };

  return {
    document: documentView,
    setVisibility(visibilityState: DocumentVisibilityState) {
      document.visibilityState = visibilityState;
      documentView.dispatchEvent(new Event("visibilitychange"));
    },
    cleanup() {
      restoreActEnvironment();
      restoreWindow();
      restoreDocument();
    },
  };
}

export async function mountReactHookTestComponent(children: ReactNode, document: Document) {
  const root = createRoot(new TestElement(document) as unknown as Element);
  await act(async () => root.render(children));
  return {
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
}
