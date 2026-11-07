import { describe, expect, it } from "vite-plus/test";

import { pickElementAtPoint } from "./PickTarget.ts";

// Models the DOM contract the picker relies on: hit-testing covers the whole page, and each
// `elementsFromPoint` retargets the hits against the scope it is called on, like Blink does.
class FakeElement {
  shadowRoot: FakeScope | null = null;
  readonly label: string;
  readonly scope: FakeScope;

  constructor(label: string, scope: FakeScope) {
    this.label = label;
    this.scope = scope;
    scope.members.add(this);
  }
}

class FakeScope {
  readonly members = new Set<FakeElement>();
  readonly host: FakeElement | null;
  private readonly page: FakePage;

  constructor(page: FakePage, host: FakeElement | null) {
    this.page = page;
    this.host = host;
  }

  contains(element: FakeElement): boolean {
    return this.members.has(element);
  }

  elementsFromPoint(): FakeElement[] {
    const elements: FakeElement[] = [];
    for (const hit of this.page.hits) {
      const element = this.retarget(hit);
      if (elements.at(-1) !== element) elements.push(element);
    }
    if (elements.at(-1) !== this.page.html) elements.push(this.page.html);
    return elements;
  }

  private retarget(target: FakeElement): FakeElement {
    let element = target;
    while (element.scope.host && !element.scope.encloses(this)) element = element.scope.host;
    return element;
  }

  private encloses(scope: FakeScope): boolean {
    for (let current: FakeScope | null = scope; current; current = current.host?.scope ?? null) {
      if (current === this) return true;
    }
    return false;
  }
}

class FakePage {
  hits: FakeElement[] = [];
  readonly overlays = new Set<FakeElement>();
  readonly document = new FakeScope(this, null);
  readonly html = new FakeElement("html", this.document);
  readonly body = new FakeElement("body", this.document);

  attachShadow(host: FakeElement, mode: "open" | "closed"): FakeScope {
    const root = new FakeScope(this, host);
    if (mode === "open") host.shadowRoot = root;
    return root;
  }

  pick(): FakeElement | null {
    return pickElementAtPoint(
      this.document,
      0,
      0,
      (element) => this.overlays.has(element) || element === this.html || element === this.body,
    );
  }
}

describe("pickElementAtPoint", () => {
  it("picks the element inside an open shadow root instead of its host", () => {
    const page = new FakePage();
    const host = new FakeElement("shadow-demo", page.document);
    const button = new FakeElement("button", page.attachShadow(host, "open"));
    page.hits = [button, host, page.body, page.html];

    expect(page.pick()?.label).toBe("button");
  });

  it("descends through nested open shadow roots", () => {
    const page = new FakePage();
    const outerHost = new FakeElement("outer-host", page.document);
    const outerRoot = page.attachShadow(outerHost, "open");
    const innerHost = new FakeElement("inner-host", outerRoot);
    const button = new FakeElement("button", page.attachShadow(innerHost, "open"));
    page.hits = [button, innerHost, outerHost, page.body, page.html];

    expect(page.pick()?.label).toBe("button");
  });

  it("falls back to the host when the point misses its shadow content", () => {
    const page = new FakePage();
    const host = new FakeElement("shadow-demo", page.document);
    page.attachShadow(host, "open");
    page.hits = [host, page.body, page.html];

    expect(page.pick()?.label).toBe("shadow-demo");
  });

  it("keeps a closed shadow root opaque", () => {
    const page = new FakePage();
    const outerHost = new FakeElement("outer-host", page.document);
    const outerRoot = page.attachShadow(outerHost, "open");
    const closedHost = new FakeElement("closed-host", outerRoot);
    const secret = new FakeElement("secret", page.attachShadow(closedHost, "closed"));
    page.hits = [secret, closedHost, outerHost, page.body, page.html];

    expect(page.pick()?.label).toBe("closed-host");
  });

  it("picks the page element beneath the picker overlay, never the overlay", () => {
    const page = new FakePage();
    const host = new FakeElement("shadow-demo", page.document);
    const button = new FakeElement("button", page.attachShadow(host, "open"));
    const overlay = new FakeElement("overlay", page.document);
    page.overlays.add(overlay);
    const toolbar = new FakeElement("toolbar", page.attachShadow(overlay, "closed"));
    page.hits = [toolbar, button, host, page.body, page.html];

    expect(page.pick()?.label).toBe("button");
  });
});
