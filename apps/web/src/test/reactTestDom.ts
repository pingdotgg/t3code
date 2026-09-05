import { vi } from "vite-plus/test";

export class ReactTestNode {
  parentNode: ReactTestNode | null = null;
  childNodes: ReactTestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};
  clientHeight = 0;
  scrollHeight = 0;
  scrollTop = 0;
  nodeValue: string | null = null;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor(
    name: string,
    readonly ownerDocument: ReactTestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  get firstChild(): ReactTestNode | null {
    return this.childNodes[0] ?? null;
  }

  set textContent(value: string) {
    this.childNodes = [];
    this.nodeValue = value;
  }

  appendChild(child: ReactTestNode): ReactTestNode {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child: ReactTestNode, before: ReactTestNode | null): ReactTestNode {
    child.parentNode = this;
    if (before === null) {
      this.childNodes.push(child);
      return child;
    }
    const index = this.childNodes.indexOf(before);
    this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild(child: ReactTestNode): ReactTestNode {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string): ReactTestNode {
    return new ReactTestNode(name, this);
  }

  createTextNode(value: string): ReactTestNode {
    const node = new ReactTestNode("#text", this, 3);
    node.nodeValue = value;
    return node;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener === null) return;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener === null) return;
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
    return true;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

export function installReactTestDom(): ReactTestNode {
  const document = new ReactTestNode("#document", null, 9);
  const window = {
    document,
    HTMLIFrameElement: ReactTestNode,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", window.HTMLIFrameElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

export function findTestNode(
  node: ReactTestNode,
  attribute: string,
  value: string,
): ReactTestNode | null {
  if (node.getAttribute(attribute) === value) return node;
  for (const child of node.childNodes) {
    const match = findTestNode(child, attribute, value);
    if (match !== null) return match;
  }
  return null;
}
