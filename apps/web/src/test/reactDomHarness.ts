class TestStyle {
  [key: string]: unknown;

  setProperty(name: string, value: string) {
    this[name] = value;
  }

  removeProperty(name: string) {
    delete this[name];
  }
}

class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI: string | null;
  readonly style = new TestStyle();
  id = "";
  private value = "";
  private markup = "";
  private readonly attributes = new Map<string, string>();

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
    namespaceURI: string | null = "http://www.w3.org/1999/xhtml",
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
    this.namespaceURI = namespaceURI;
  }

  get firstChild(): TestNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): TestNode | null {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[index + 1] ?? null;
  }

  get textContent(): string {
    if (this.nodeType === 3 || this.nodeType === 8) return this.value;
    return this.childNodes.map((child) => child.textContent).join("");
  }

  get innerHTML() {
    return this.markup;
  }

  set innerHTML(value: string) {
    this.markup = value;
    this.childNodes = [];
  }

  set textContent(value: string) {
    if (this.nodeType === 3 || this.nodeType === 8) {
      this.value = value;
      return;
    }
    this.childNodes = [];
    if (value) this.appendChild(this.document().createTextNode(value));
  }

  get nodeValue() {
    return this.nodeType === 3 || this.nodeType === 8 ? this.value : null;
  }

  set nodeValue(value: string | null) {
    if (this.nodeType === 3 || this.nodeType === 8) this.value = value ?? "";
  }

  appendChild(child: TestNode) {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  prepend(child: TestNode) {
    return this.insertBefore(child, this.firstChild);
  }

  insertBefore(child: TestNode, before: TestNode | null) {
    if (!before) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    const index = this.childNodes.indexOf(before);
    if (index < 0) throw new Error("insertBefore reference is not a child");
    child.parentNode = this;
    this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild(child: TestNode) {
    const index = this.childNodes.indexOf(child);
    if (index < 0) throw new Error("removeChild target is not a child");
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this.document());
  }

  createElementNS(namespaceURI: string, name: string) {
    return new TestNode(name, this.document(), 1, namespaceURI);
  }

  createTextNode(value: string) {
    const node = new TestNode("#text", this.document(), 3, null);
    node.nodeValue = value;
    return node;
  }

  createComment(value: string) {
    const node = new TestNode("#comment", this.document(), 8, null);
    node.nodeValue = value;
    return node;
  }

  getElementById(id: string): TestNode | null {
    if (this.id === id || this.getAttribute("id") === id) return this;
    for (const child of this.childNodes) {
      const match = child.getElementById(id);
      if (match) return match;
    }
    return null;
  }

  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  setAttributeNS(_namespace: string | null, name: string, value: unknown) {
    this.setAttribute(name, value);
  }

  removeAttributeNS(_namespace: string | null, name: string) {
    this.removeAttribute(name);
  }

  addEventListener() {}
  removeEventListener() {}

  private document(): TestNode {
    return this.nodeType === 9 ? this : (this.ownerDocument ?? this);
  }
}

export function installReactTestDom(stubGlobal: (name: string, value: unknown) => void) {
  const document = new TestNode("#document", null, 9, null);
  const body = document.createElement("body");
  document.appendChild(body);
  Object.assign(document, { body });
  const observer = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const window = {
    document,
    Node: TestNode,
    Element: TestNode,
    HTMLElement: TestNode,
    HTMLIFrameElement: TestNode,
    SVGElement: TestNode,
    MutationObserver: observer,
    ResizeObserver: observer,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({}),
  };
  stubGlobal("document", document);
  stubGlobal("window", window);
  stubGlobal("Node", TestNode);
  stubGlobal("Element", TestNode);
  stubGlobal("HTMLElement", TestNode);
  stubGlobal("HTMLIFrameElement", TestNode);
  stubGlobal("SVGElement", TestNode);
  stubGlobal("MutationObserver", observer);
  stubGlobal("ResizeObserver", observer);
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}
