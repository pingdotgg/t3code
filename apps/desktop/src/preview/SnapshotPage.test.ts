import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

import { snapshotPageExpression, type SnapshotPage } from "./SnapshotPage.ts";

const rect = (x: number, y: number, width = 100, height = 20) => ({
  x,
  y,
  left: x,
  top: y,
  right: x + width,
  bottom: y + height,
  width,
  height,
});

class PageElement {
  nodeType = 1;
  tagName = "DIV";
  id = "";
  innerText = "";
  parentElement: PageElement | null = null;
  offsetParent: PageElement | null = null;
  children: PageElement[] = [];
  attributes = new Map<string, string>();
  clientLeft = 0;
  clientTop = 0;
  clientWidth = 100;
  clientHeight = 20;
  offsetWidth = 100;
  offsetHeight = 20;
  scrollWidth = 100;
  scrollHeight = 20;
  scrollLeft = 0;
  scrollTop = 0;
  bounds = rect(0, 0);
  style = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    contentVisibility: "visible",
    overflowX: "visible",
    overflowY: "visible",
    position: "static",
    transform: "none",
    rotate: "none",
    scale: "none",
    perspective: "none",
    filter: "none",
    backdropFilter: "none",
    contain: "none",
    clipPath: "none",
    overflowClipMargin: "0px",
    willChange: "auto",
    borderRightWidth: "0px",
    borderBottomWidth: "0px",
  };
  getAttribute(attribute: string) {
    return this.attributes.get(attribute) ?? null;
  }
  getBoundingClientRect() {
    return this.bounds;
  }
  checkVisibility(options: { checkVisibilityCSS?: boolean } = {}) {
    const ancestors: PageElement[] = [this];
    if (this.parentElement) ancestors.push(this.parentElement);
    for (let index = 0; index < ancestors.length; index++) {
      const current = ancestors[index]!;
      if (index > 0 && current.parentElement) ancestors.push(current.parentElement);
      if (
        current.style.display === "none" ||
        current.style.opacity === "0" ||
        current.style.contentVisibility === "hidden"
      )
        return false;
    }
    return (
      (!options.checkVisibilityCSS || this.style.visibility === "visible") &&
      this.style.display !== "contents"
    );
  }
}

type PageText = {
  nodeType: number;
  data: string;
  length: number;
  parentElement: PageElement;
  rectangles: (start: number, end: number) => ReturnType<typeof rect>[];
};

const fixture = (escape = (value: string) => value) => {
  const root = new PageElement();
  const body = new PageElement();
  body.parentElement = root;
  root.children.push(body);
  root.scrollHeight = 10_000;
  const elements: PageElement[] = [];
  const selectorMatches = new Map<string, PageElement[]>();
  const nodes: Array<PageElement | PageText> = [];
  const element = (id: string, bounds: ReturnType<typeof rect>, parent = body) => {
    const value = new PageElement();
    value.id = id;
    value.bounds = bounds;
    value.parentElement = parent;
    parent.children.push(value);
    nodes.push(value);
    return value;
  };
  const text = (
    data: string,
    parent: PageElement,
    rectangles: PageText["rectangles"] = () => [parent.bounds],
  ) => {
    const value = { nodeType: 3, data, length: data.length, parentElement: parent, rectangles };
    nodes.push(value);
  };
  let start = 0;
  let end = 0;
  let active: PageText;
  const range = {
    setStart(node: PageText, offset: number) {
      active = node;
      start = offset;
    },
    setEnd(_node: PageText, offset: number) {
      end = offset;
    },
    getClientRects() {
      return active.rectangles(start, end);
    },
    getBoundingClientRect() {
      const rectangles = this.getClientRects();
      const left = Math.min(...rectangles.map((value) => value.left));
      const top = Math.min(...rectangles.map((value) => value.top));
      return rect(
        left,
        top,
        Math.max(...rectangles.map((value) => value.right)) - left,
        Math.max(...rectangles.map((value) => value.bottom)) - top,
      );
    },
  };
  const context = {
    innerWidth: 300,
    innerHeight: 200,
    scrollX: 0,
    scrollY: 4_000,
    location: { href: "https://example.test" },
    CSS: { escape },
    DOMMatrixReadOnly: class {
      transform: string;
      constructor(transform: string) {
        this.transform = transform;
      }
      toFloat64Array() {
        const values = this.transform
          .slice(this.transform.indexOf("(") + 1, -1)
          .split(",")
          .map(Number);
        return new Float64Array(
          values.length === 16
            ? values
            : [
                values[0]!,
                values[1]!,
                0,
                0,
                values[2]!,
                values[3]!,
                0,
                0,
                0,
                0,
                1,
                0,
                values[4]!,
                values[5]!,
                0,
                1,
              ],
        );
      }
    },
    HTMLElement: PageElement,
    Node: { ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    getComputedStyle: (value: PageElement) => value.style,
    document: {
      documentElement: root,
      body,
      scrollingElement: root as PageElement | null,
      title: "Page",
      readyState: "complete",
      compatMode: "CSS1Compat",
      querySelectorAll(selector: string) {
        if (selector === "a[href],button,input,textarea,select,[role],[tabindex]") return elements;
        if (selectorMatches.has(selector)) return selectorMatches.get(selector)!;
        return Array.from(
          new Set([root, body, ...nodes.filter((node) => node instanceof PageElement)]),
        ).filter(
          (element) =>
            (element.id && selector === "#" + element.id) ||
            ["name", "data-testid"].some(
              (attribute) =>
                selector ===
                element.tagName.toLowerCase() +
                  "[" +
                  attribute +
                  "=" +
                  element.getAttribute(attribute) +
                  "]",
            ),
        );
      },
      createRange: () => range,
      createTreeWalker() {
        let index = 0;
        return { nextNode: () => nodes[index++] ?? null };
      },
    },
  };
  const capture = (scrollingElement: PageElement | null = root, compatMode = "CSS1Compat") => {
    context.document.scrollingElement = scrollingElement;
    context.document.compatMode = compatMode;
    return NodeVM.runInNewContext(snapshotPageExpression(), context) as SnapshotPage;
  };
  return { root, body, elements, nodes, selectorMatches, element, text, capture };
};

describe("snapshot page collector", () => {
  it.each(["id", "name", "data-testid"])(
    "uses unique document paths for duplicate %s targets in deep branches",
    (attribute) => {
      const page = fixture();
      for (let branch = 0; branch < 2; branch++) {
        let parent = page.element("", rect(0, 0));
        parent.tagName = "SECTION";
        for (let depth = 0; depth < 9; depth++) parent = page.element("", rect(0, 0), parent);
        const scroller = page.element("", rect(0, 0), parent);
        scroller.style.overflowY = "auto";
        scroller.scrollHeight = 1_000;
        const control = page.element("", rect(0, 0), scroller);
        control.tagName = "BUTTON";
        if (attribute === "id") scroller.id = control.id = "duplicate";
        else {
          scroller.attributes.set(attribute, "duplicate");
          control.attributes.set(attribute, "duplicate");
        }
        page.elements.push(control);
      }
      const snapshot = page.capture();
      const paths = [1, 2].map(
        (branch) =>
          ":root > div > section:nth-of-type(" +
          branch +
          ") > " +
          Array.from({ length: 10 }, () => "div").join(" > "),
      );
      expect(snapshot.scroll?.containers.map((container) => container.selector)).toEqual(paths);
      expect(snapshot.interactiveElements.map((element) => element.selector)).toEqual(
        paths.map((path) => path + " > button"),
      );
    },
  );

  it.each(["id", "name", "data-testid"])("keeps short unique %s selectors", (attribute) => {
    const page = fixture();
    const control = page.element("", rect(0, 0));
    control.tagName = "BUTTON";
    if (attribute === "id") control.id = "unique";
    else control.attributes.set(attribute, "unique");
    page.elements.push(control);
    expect(page.capture().interactiveElements[0]?.selector).toBe(
      attribute === "id" ? "#unique" : "button[" + attribute + "=unique]",
    );
  });

  it("uses a unique attribute when an id is duplicated", () => {
    const page = fixture();
    page.element("duplicate", rect(0, 0));
    const control = page.element("duplicate", rect(0, 0));
    control.tagName = "BUTTON";
    control.attributes.set("data-testid", "unique");
    page.elements.push(control);
    expect(page.capture().interactiveElements[0]?.selector).toBe("button[data-testid=unique]");
  });

  it("reports omitted scroll containers when the unique ancestor path exceeds its budget", () => {
    const page = fixture();
    let scroller = page.body;
    for (let depth = 0; depth < 200; depth++) scroller = page.element("", rect(0, 0), scroller);
    scroller.style.overflowY = "auto";
    scroller.scrollHeight = 1_000;
    page.text("current label", scroller);
    const snapshot = page.capture();
    expect(snapshot.viewportText).toBe("current label");
    expect(snapshot.scroll?.containers).toEqual([]);
    expect(snapshot.scroll?.containersTruncated).toBe(true);
  });

  it.each([
    ["transform", "matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)"],
    ["transform", "matrix(1, 0, 0.5, 1, 0, 0)"],
    ["transform", "matrix(-1, 0, 0, 1, 0, 0)"],
    ["transform", "matrix3d(1,0,0,0,0,1,0,0,0,0,1,-0.002,0,0,0,1)"],
    ["rotate", "45deg"],
    ["perspective", "500px"],
    ["scale", "-1 1"],
  ] as const)("omits unsupported %s=%s clipping geometry", (property, value) => {
    for (const effect of ["overflow", "contain", "path"]) {
      for (const onAncestor of [false, true]) {
        const page = fixture();
        const parent = page.element("parent", rect(0, 0));
        const scroller = page.element("scroll", rect(0, 0), parent);
        (onAncestor ? parent : scroller).style[property] = value;
        scroller.style.overflowY = "auto";
        scroller.scrollHeight = 1_000;
        if (effect === "contain") scroller.style.contain = "paint";
        if (effect === "path") scroller.style.clipPath = "inset(0px)";
        const uncertain = page.element("uncertain", rect(10, 5, 20, 10), scroller);
        page.elements.push(uncertain);
        page.text("uncertain label", uncertain);
        const visible = page.element("visible", rect(0, 100));
        page.elements.push(visible);
        page.text("visible label", visible);
        page.body.innerText = "uncertain label visible label";
        const snapshot = page.capture();
        expect(snapshot.viewportText).toBe("visible label");
        expect(snapshot.visibleText).toBe("uncertain label visible label");
        expect(snapshot.interactiveElements.map((element) => element.selector)).toEqual([
          "#visible",
        ]);
        expect(snapshot.scroll?.containers).toEqual([]);
        expect(snapshot.scroll?.containersTruncated).toBe(true);
        expect(snapshot.truncated?.viewportText).toBe(true);
        expect(snapshot.truncated?.interactiveElements).toBe(true);
      }
    }
  });

  it.each([
    ["transform", "matrix(2, 0, 0, 3, 10, 20)"],
    ["transform", "matrix(1, 0, 0, 1, 30, -10)"],
    ["transform", "matrix3d(2,0,0,0,0,3,0,0,0,0,1,0,10,20,30,1)"],
    ["rotate", "360deg"],
    ["scale", "2 3"],
  ] as const)("keeps axis-aligned %s=%s clipping", (property, value) => {
    const page = fixture();
    const scroller = page.element("scroll", rect(0, 0, 200, 60));
    scroller.style[property] = value;
    scroller.style.overflowY = "auto";
    scroller.style.contain = "paint";
    scroller.style.clipPath = "inset(0px)";
    scroller.scrollHeight = 1_000;
    const visible = page.element("visible", rect(20, 10), scroller);
    page.elements.push(visible);
    page.text("visible label", visible);
    const snapshot = page.capture();
    expect(snapshot.viewportText).toBe("visible label");
    expect(snapshot.interactiveElements[0]?.inViewport).toBe(true);
    expect(snapshot.scroll?.containers[0]?.selector).toBe("#scroll");
    expect(snapshot.scroll?.containersTruncated).toBe(false);
    expect(snapshot.truncated?.viewportText).toBe(false);
    expect(snapshot.truncated?.interactiveElements).toBe(false);
  });

  it("preserves positioned overflow escapes but respects transformed paint clipping", () => {
    const page = fixture();
    const rotated = page.element("rotated", rect(0, 0));
    rotated.style.rotate = "45deg";
    const scroller = page.element("scroll", rect(0, 0), rotated);
    scroller.style.overflowY = "auto";
    scroller.scrollHeight = 1_000;
    const escaped = page.element("escaped", rect(0, 100), scroller);
    escaped.style.position = "absolute";
    escaped.offsetParent = rotated;
    page.elements.push(escaped);
    page.text("escaped label", escaped);
    const snapshot = page.capture();
    expect(snapshot.viewportText).toBe("escaped label");
    expect(snapshot.interactiveElements[0]?.selector).toBe("#escaped");
    expect(snapshot.interactiveElements[0]?.inViewport).toBe(true);
    scroller.style.contain = "paint";
    const painted = page.capture();
    expect(painted.viewportText).toBe("");
    expect(painted.interactiveElements).toEqual([]);
    expect(painted.truncated?.interactiveElements).toBe(true);
  });

  it("keeps transformed text and controls when no geometric clipping applies", () => {
    const page = fixture();
    const rotated = page.element("rotated", rect(0, 0));
    rotated.style.rotate = "45deg";
    page.elements.push(rotated);
    page.text("rotated label", rotated);
    const snapshot = page.capture();
    expect(snapshot.viewportText).toBe("rotated label");
    expect(snapshot.interactiveElements[0]?.inViewport).toBe(true);
    expect(snapshot.truncated?.viewportText).toBe(false);
    expect(snapshot.truncated?.interactiveElements).toBe(false);
  });

  it.each(["inset(100%)", "inset(0px 0px 100%)", "circle(50%)"])(
    "omits scroll containers clipped by %s",
    (clipPath) => {
      for (const onAncestor of [false, true]) {
        const page = fixture();
        const parent = page.element("parent", rect(0, 0));
        const scroller = page.element("scroll", rect(0, 0), parent);
        (onAncestor ? parent : scroller).style.clipPath = clipPath;
        scroller.style.overflowY = "auto";
        scroller.scrollHeight = 1_000;
        const snapshot = page.capture();
        expect(snapshot.scroll?.containers).toEqual([]);
        expect(snapshot.scroll?.containersTruncated).toBe(clipPath === "circle(50%)");
      }
    },
  );

  it("keeps partially clipped scroll containers and omits known offscreen areas", () => {
    const page = fixture();
    const visible = page.element("partial", rect(0, 0));
    visible.style.clipPath = "inset(50% 0px 0px)";
    visible.style.overflowY = "auto";
    visible.scrollHeight = 1_000;
    const offscreen = page.element("offscreen", rect(0, 250));
    offscreen.style.clipPath = "inset(0px)";
    offscreen.style.overflowY = "auto";
    offscreen.scrollHeight = 1_000;
    const snapshot = page.capture();
    expect(snapshot.scroll?.containers.map((container) => container.selector)).toEqual([
      "#partial",
    ]);
    expect(snapshot.scroll?.containersTruncated).toBe(false);
  });

  it.each(["paint", "content", "strict", "layout"])(
    "respects %s containment on boxes and the body",
    (contain) => {
      for (const onBody of [false, true]) {
        const page = fixture();
        const parent = onBody ? page.body : page.element("clip", rect(0, 0, 150, 60));
        parent.bounds = rect(0, 0, 150, 60);
        parent.clientWidth = parent.offsetWidth = 150;
        parent.clientHeight = parent.offsetHeight = 60;
        parent.style.contain = contain;
        const hidden = page.element("hidden", rect(0, 120), parent);
        page.elements.push(hidden);
        page.text("hidden label", hidden);
        const snapshot = page.capture();
        expect(snapshot.viewportText).toBe(contain === "layout" ? "hidden label" : "");
        expect(snapshot.interactiveElements[0]?.inViewport).toBe(contain === "layout");
      }
    },
  );

  it.each(["inset(0px)", "inset(0%)", "inset(10px 10% 20px 5%)"])(
    "clips text and controls with %s on boxes and the body",
    (clipPath) => {
      for (const onBody of [false, true]) {
        const page = fixture();
        const parent = onBody ? page.body : page.element("clip", rect(0, 0, 150, 60));
        parent.bounds = rect(0, 0, 150, 60);
        parent.offsetWidth = 150;
        parent.offsetHeight = 60;
        parent.style.clipPath = clipPath;
        const hidden = page.element("hidden", rect(0, 120), parent);
        const visible = page.element("visible", rect(20, 20, 50, 10), parent);
        page.elements.push(hidden, visible);
        page.text("hidden label", hidden);
        page.text("visible label", visible);
        const snapshot = page.capture();
        expect(snapshot.viewportText).toBe("visible label");
        expect(snapshot.interactiveElements.map((element) => element.inViewport)).toEqual([
          true,
          false,
        ]);
        expect(snapshot.truncated?.viewportText).toBe(false);
      }
    },
  );

  it("clips positioned descendants at static clip-path ancestors", () => {
    const page = fixture();
    const parent = page.element("clip", rect(0, 0, 150, 60));
    parent.style.clipPath = "inset(0px)";
    for (const position of ["fixed", "absolute"]) {
      const hidden = page.element(position, rect(0, 120), parent);
      hidden.style.position = position;
      hidden.offsetParent = position === "absolute" ? page.body : null;
      page.elements.push(hidden);
      page.text("hidden label", hidden);
    }
    const snapshot = page.capture();
    expect(snapshot.viewportText).toBe("");
    expect(snapshot.interactiveElements.every((element) => !element.inViewport)).toBe(true);
  });

  it.each(["inline", "table-row", "ruby", "ruby-text"])(
    "does not apply paint containment to %s boxes",
    (display) => {
      const page = fixture();
      const parent = page.element("clip", rect(0, 0));
      parent.style.display = display;
      parent.style.contain = "paint";
      const visible = page.element("visible", rect(0, 120), parent);
      visible.style.position = "absolute";
      visible.offsetParent = page.body;
      page.elements.push(visible);
      page.text("visible label", visible);
      const snapshot = page.capture();
      expect(snapshot.viewportText).toBe("visible label");
      expect(snapshot.interactiveElements[0]?.inViewport).toBe(true);
    },
  );

  it("respects paint containment overflow clip margins", () => {
    const page = fixture();
    const parent = page.element("clip", rect(0, 0, 100, 100));
    parent.offsetHeight = 100;
    parent.style.contain = "paint";
    parent.style.overflowClipMargin = "padding-box 20px";
    const visible = page.element("visible", rect(0, 105, 50, 10), parent);
    const hidden = page.element("hidden", rect(0, 140), parent);
    page.elements.push(visible, hidden);
    page.text("visible label", visible);
    page.text("hidden label", hidden);
    const snapshot = page.capture();
    expect(snapshot.viewportText).toBe("visible label");
    expect(snapshot.interactiveElements.map((element) => element.inViewport)).toEqual([
      true,
      false,
    ]);
    parent.style.overflowClipMargin = "content-box 20px";
    const omitted = page.capture();
    expect(omitted.viewportText).toBe("");
    expect(omitted.interactiveElements).toEqual([]);
    expect(omitted.truncated?.viewportText).toBe(true);
    expect(omitted.truncated?.interactiveElements).toBe(true);
  });

  it.each(["paint", "layout"])(
    "finds independent body scrolling when %s containment prevents overflow propagation",
    (contain) => {
      for (const onRoot of [false, true]) {
        const page = fixture();
        (onRoot ? page.root : page.body).style.contain = contain;
        page.root.bounds = rect(0, 0, 300, 200);
        page.body.bounds = rect(0, 0, 150, 60);
        page.body.clientWidth = page.body.offsetWidth = 150;
        page.body.clientHeight = page.body.offsetHeight = 60;
        page.body.style.overflowY = "auto";
        page.body.scrollHeight = 500;
        page.body.scrollTop = 200;
        const hidden = page.element("hidden", rect(0, 120));
        page.elements.push(hidden);
        page.text("hidden label", hidden);
        const snapshot = page.capture();
        expect(snapshot.viewportText).toBe("");
        expect(snapshot.interactiveElements[0]?.inViewport).toBe(false);
        expect(snapshot.scroll?.containers[0]).toMatchObject({
          y: 200,
          height: 60,
          scrollHeight: 500,
        });
      }
    },
  );

  it("uses border-box inset percentages and permits negative insets", () => {
    const page = fixture();
    const parent = page.element("clip", rect(0, 0, 100, 100));
    parent.clientLeft = parent.clientTop = 10;
    parent.style.borderRightWidth = parent.style.borderBottomWidth = "10px";
    parent.style.clipPath = "inset(0px)";
    const label = page.element("label", rect(2, 2, 5, 5), parent);
    page.text("border label", label);
    expect(page.capture().viewportText).toBe("border label");
    parent.style.contain = "paint";
    expect(page.capture().viewportText).toBe("");
    parent.style.contain = "none";
    parent.style.clipPath = "inset(-50px)";
    label.bounds = rect(0, 120);
    expect(page.capture().viewportText).toBe("border label");
    parent.style.clipPath = "inset(0 0 50%)";
    label.bounds = rect(0, 60);
    expect(page.capture().viewportText).toBe("");
  });

  it.each(["circle(50%)", "inset(0px round 20px)", "inset(calc(10px + 5%))"])(
    "reports omitted text and controls for unsupported %s geometry",
    (clipPath) => {
      const page = fixture();
      const parent = page.element("clip", rect(0, 0, 100, 100));
      parent.style.clipPath = clipPath;
      const uncertain = page.element("uncertain", rect(20, 20), parent);
      uncertain.style.position = "fixed";
      const visible = page.element("visible", rect(0, 140));
      page.elements.push(uncertain, visible);
      page.text("uncertain label", uncertain);
      page.text("visible label", visible);
      page.body.innerText = "uncertain label visible label";
      const snapshot = page.capture();
      expect(snapshot.viewportText).toBe("visible label");
      expect(snapshot.visibleText).toBe("uncertain label visible label");
      expect(snapshot.interactiveElements.map((element) => element.selector)).toEqual(["#visible"]);
      expect(snapshot.truncated?.viewportText).toBe(true);
      expect(snapshot.truncated?.interactiveElements).toBe(true);
    },
  );

  it.each(["name", "data-testid"])("escapes line breaks in %s selectors", (attribute) => {
    const page = fixture((value) => value.replaceAll("\n", "\\a "));
    const control = page.element("", rect(0, 0));
    control.tagName = "BUTTON";
    control.attributes.set(attribute, "line\nnext");
    page.selectorMatches.set(`button[${attribute}=line\\a next]`, [control]);
    page.elements.push(control);
    expect(page.capture().interactiveElements[0]?.selector).toBe(
      `button[${attribute}=line\\a next]`,
    );
  });

  it("finds image and canvas scroll areas without text or controls", () => {
    const page = fixture();
    for (const tag of ["IMG", "CANVAS"]) {
      const scroller = page.element(`scroll-${tag}`, rect(0, 0));
      scroller.style.overflowY = "auto";
      scroller.scrollHeight = 1_000;
      scroller.scrollTop = 200;
      page.element("", rect(0, 0), scroller).tagName = tag;
    }
    const hidden = page.element("hidden", rect(0, 0));
    hidden.style.opacity = "0";
    const hiddenScroller = page.element("hidden-scroll", rect(0, 0), hidden);
    hiddenScroller.style.overflowY = "auto";
    hiddenScroller.scrollHeight = 1_000;
    const clipped = page.element("clipping", rect(0, 0));
    clipped.style.overflowY = "hidden";
    const clippedScroller = page.element("clipped-scroll", rect(0, 100), clipped);
    clippedScroller.style.overflowY = "auto";
    clippedScroller.scrollHeight = 1_000;
    const snapshot = page.capture();
    expect(snapshot.viewportText).toBe("");
    expect(snapshot.interactiveElements).toEqual([]);
    expect(
      snapshot.scroll?.containers.map((container) => [container.selector, container.y]),
    ).toEqual([
      ["#scroll-IMG", 200],
      ["#scroll-CANVAS", 200],
    ]);
  });

  it("finds an independently scrolling image-only body", () => {
    const page = fixture();
    page.root.style.overflowY = "hidden";
    page.body.style.overflowY = "auto";
    page.body.scrollHeight = 1_000;
    page.element("image", rect(0, 0)).tagName = "IMG";
    expect(page.capture().scroll?.containers[0]?.height).toBe(20);
  });

  it("keeps scanning scroll areas after text is capped and reports an incomplete scan", () => {
    const page = fixture();
    page.text("x".repeat(25_000), page.element("text", rect(0, 0)));
    const scroller = page.element("later-scroll", rect(0, 0));
    scroller.style.overflowY = "auto";
    scroller.scrollHeight = 1_000;
    expect(page.capture().scroll?.containers[0]?.selector).toBe("#later-scroll");
    const empty = page.element("empty", rect(0, 0));
    page.nodes.length = 100_001;
    page.nodes.fill(empty);
    const snapshot = page.capture();
    expect(snapshot.truncated?.viewportText).toBe(true);
    expect(snapshot.scroll?.containersTruncated).toBe(true);
  });

  it("keeps bottom text after more than 4096 offscreen paragraphs", () => {
    const page = fixture();
    for (let index = 0; index < 5_000; index++) {
      page.text("offscreen", page.element(`paragraph-${index}`, rect(0, -100)));
    }
    page.text("bottom marker", page.element("bottom", rect(0, 100)));
    const snapshot = page.capture();
    expect(snapshot.viewportText).toBe("bottom marker");
    expect(snapshot.truncated?.viewportText).toBe(false);
  });

  it("reads direct display:contents text while respecting hidden ancestors", () => {
    const page = fixture();
    const contents = page.element("contents", rect(0, 0, 0, 0));
    contents.style.display = "contents";
    page.text("direct contents text", contents, () => [rect(0, 20)]);
    const hidden = page.element("hidden", rect(0, 40));
    hidden.style.opacity = "0";
    const hiddenContents = page.element("hidden-contents", rect(0, 0, 0, 0), hidden);
    hiddenContents.style.display = "contents";
    page.text("hidden contents text", hiddenContents, () => [rect(0, 40)]);
    const visibility = page.element("visibility", rect(0, 60));
    visibility.style.visibility = "hidden";
    const override = page.element("override", rect(0, 0, 0, 0), visibility);
    override.style.display = "contents";
    page.text("visible override", override, () => [rect(0, 60)]);
    expect(page.capture().viewportText).toBe("direct contents text visible override");
  });

  it("captures text under deeply nested ancestors without recursive stack growth", () => {
    const page = fixture();
    let parent = page.body;
    for (let index = 0; index < 5_000; index++)
      parent = page.element(`nested-${index}`, rect(0, 100), parent);
    page.text("deep text", parent);
    expect(page.capture().viewportText).toBe("deep text");
  });

  it("clips an independently scrolling body in standard and quirks documents", () => {
    const page = fixture();
    page.root.style.overflowY = "hidden";
    page.body.style.overflowY = "auto";
    page.body.bounds = rect(0, 0, 300, 100);
    page.body.clientWidth = page.body.offsetWidth = 300;
    page.body.clientHeight = page.body.offsetHeight = 100;
    page.body.scrollHeight = 1_000;
    page.body.scrollTop = 200;
    const clipped = page.element("body-clipped", rect(0, 140));
    page.elements.push(clipped);
    page.text("clipped body text", clipped);
    for (const scrollingElement of [page.root, null]) {
      const snapshot = page.capture(scrollingElement);
      expect(snapshot.viewportText).toBe("");
      expect(snapshot.interactiveElements[0]?.inViewport).toBe(false);
      expect(snapshot.scroll?.containers[0]).toMatchObject({
        selector: ":root > div",
        y: 200,
        height: 100,
        scrollHeight: 1_000,
      });
    }
  });

  it("uses the actual body box when quirks client dimensions report the viewport", () => {
    const page = fixture();
    page.root.style.overflowX = page.root.style.overflowY = "hidden";
    page.body.style.overflowX = page.body.style.overflowY = "auto";
    page.body.bounds = rect(0, 0, 200, 200);
    page.body.clientWidth = 300;
    page.body.clientHeight = 800;
    page.body.offsetWidth = page.body.offsetHeight = 100;
    page.body.clientLeft = page.body.clientTop = 2;
    page.body.style.borderRightWidth = page.body.style.borderBottomWidth = "2px";
    page.body.scrollWidth = 300;
    page.body.scrollHeight = 245;
    const vertical = page.element("vertical", rect(10, 198, 50, 2));
    const horizontal = page.element("horizontal", rect(198, 10, 2, 50));
    page.elements.push(vertical, horizontal);
    page.text("vertical text", vertical);
    page.text("horizontal text", horizontal);
    const snapshot = page.capture(null, "BackCompat");
    expect(snapshot.viewportText).toBe("");
    expect(snapshot.interactiveElements.every((element) => element.inViewport === false)).toBe(
      true,
    );
    expect(snapshot.scroll?.containers[0]).toMatchObject({
      width: 96,
      height: 96,
      scrollWidth: 300,
      scrollHeight: 245,
    });
    page.body.offsetHeight = 1_000;
    page.body.bounds = rect(0, 0, 200, 2_000);
    page.body.scrollHeight = 2_000;
    expect(page.capture(null, "BackCompat").scroll?.containers[0]?.height).toBe(996);
  });

  it("keeps current controls ahead of more than 200 offscreen controls", () => {
    const page = fixture();
    for (let index = 0; index < 240; index++) {
      const control = page.element(`button-${index}`, rect(0, index < 239 ? -1_000 : 100));
      control.tagName = "BUTTON";
      page.elements.push(control);
    }
    page.body.innerText = "whole page ".repeat(3_000);
    page.text("on screen", page.elements[239]!);
    const snapshot = page.capture();
    expect(snapshot.interactiveElements).toHaveLength(200);
    expect(snapshot.interactiveElements[0]).toMatchObject({
      selector: "#button-239",
      inViewport: true,
    });
    expect(snapshot.viewportText).toBe("on screen");
    expect(snapshot.visibleText).toHaveLength(20_000);
    expect(snapshot.truncated).toEqual({
      visibleText: true,
      viewportText: false,
      interactiveElements: true,
    });
    expect(snapshot.scroll).toMatchObject({ y: 4_000, height: 200, scrollHeight: 10_000 });
  });

  it("clips nested scroll text and controls without changing scroll offsets", () => {
    const page = fixture();
    const outer = page.element("outer", rect(10, 10, 100, 100));
    outer.clientHeight = 100;
    outer.offsetHeight = 100;
    outer.style.overflowY = "auto";
    outer.scrollHeight = 1_000;
    outer.scrollTop = 600;
    const inner = page.element("inner", rect(20, 30, 80, 40), outer);
    inner.clientWidth = inner.offsetWidth = 80;
    inner.clientHeight = inner.offsetHeight = 40;
    inner.style.overflowX = "hidden";
    inner.style.overflowY = "clip";
    const visible = page.element("visible", rect(20, 35, 70, 20), inner);
    const clipped = page.element("clipped", rect(20, 80, 70, 20), inner);
    page.elements.push(clipped, visible);
    page.text("visible words", visible);
    page.text("hidden under scroll", clipped);
    const snapshot = page.capture();
    expect(snapshot.viewportText).toBe("visible words");
    expect(snapshot.interactiveElements[0]).toMatchObject({
      selector: "#visible",
      inViewport: true,
    });
    expect(snapshot.interactiveElements[1]).toMatchObject({
      selector: "#clipped",
      inViewport: false,
    });
    expect(snapshot.scroll?.containers).toEqual([
      {
        selector: "#outer",
        x: 0,
        y: 600,
        width: 100,
        height: 100,
        scrollWidth: 100,
        scrollHeight: 1_000,
      },
    ]);
    expect(outer.scrollTop).toBe(600);
  });

  it("reads only visible characters from a huge wrapped text node", () => {
    const page = fixture();
    const parent = page.element("long", rect(0, -100_000, 100, 200_000));
    const data = "x".repeat(100_000) + "VISIBLE" + "z".repeat(100_000);
    page.text(data, parent, (start: number, end: number) => {
      const rectangles = [];
      if (start < 100_000) rectangles.push(rect(0, -100, 100, 20));
      if (end > 100_000 && start < 100_007) rectangles.push(rect(0, 100, 100, 20));
      if (end > 100_007) rectangles.push(rect(0, 500, 100, 20));
      return rectangles;
    });
    expect(page.capture().viewportText).toBe("VISIBLE");
  });

  it("clips positioned descendants at their containing block", () => {
    const page = fixture();
    const scroller = page.element("scroller", rect(0, 0));
    scroller.style.overflowY = "auto";
    scroller.scrollHeight = 1_000;
    const fixed = page.element("fixed", rect(180, 100), scroller);
    fixed.style.position = "fixed";
    const absolute = page.element("absolute", rect(0, 140), scroller);
    absolute.style.position = "absolute";
    absolute.offsetParent = page.body;
    const transformed = page.element("transformed", rect(0, 0));
    transformed.style.overflowY = "hidden";
    transformed.style.transform = "matrix(1, 0, 0, 1, 0, 0)";
    const clipped = page.element("clipped", rect(0, 160), transformed);
    clipped.style.position = "fixed";
    clipped.offsetParent = transformed;
    page.elements.push(fixed, absolute, clipped);
    page.text("fixed label", fixed);
    page.text("absolute label", absolute);
    page.text("clipped label", clipped);
    const snapshot = page.capture();
    expect(snapshot.viewportText).toBe("fixed label absolute label");
    expect(
      snapshot.interactiveElements.map((element) => [element.selector, element.inViewport]),
    ).toEqual([
      ["#fixed", true],
      ["#absolute", true],
      ["#clipped", false],
    ]);
  });

  it("omits hidden styles and clips horizontal text", () => {
    const page = fixture();
    const transparent = page.element("transparent", rect(0, 0));
    transparent.style.opacity = "0";
    const hidden = page.element("hidden", rect(0, 20));
    hidden.style.contentVisibility = "hidden";
    const visibility = page.element("visibility", rect(0, 40));
    visibility.style.visibility = "hidden";
    for (const parent of [transparent, hidden, visibility]) page.text("secret", parent);
    const clipped = page.element("horizontal", rect(-100, 60, 500, 20));
    page.text("abcdefghijklmnopqrst", clipped, (start: number, end: number) => [
      rect(-100 + start * 25, 60, (end - start) * 25, 20),
    ]);
    expect(page.capture().viewportText).toBe("efghijklmnop");
  });

  it("reports capped viewport text and scroll container metadata", () => {
    let selectorsRead = 0;
    const page = fixture((value) => {
      selectorsRead++;
      return value;
    });
    for (let index = 0; index < 21; index++) {
      const container = page.element(`scroll-${index}`, rect(0, 0));
      container.style.overflowY = "scroll";
      container.scrollHeight = 100;
      page.text("text", container);
    }
    const large = page.element("large", rect(0, 100));
    page.text("x".repeat(25_000), large);
    const snapshot = page.capture();
    expect(snapshot.scroll?.containers).toHaveLength(20);
    expect(snapshot.scroll?.containersTruncated).toBe(true);
    expect(selectorsRead).toBe(20);
    expect(snapshot.viewportText).toHaveLength(20_000);
    expect(snapshot.truncated?.viewportText).toBe(true);
  });

  it("omits oversized scroll selectors while preserving current text", () => {
    const page = fixture();
    const container = page.element("x".repeat(2_000), rect(0, 0));
    container.style.overflowY = "scroll";
    container.scrollHeight = 1_000;
    page.text("current text", container);
    const snapshot = page.capture();
    expect(snapshot.viewportText).toBe("current text");
    expect(snapshot.scroll?.containers).toEqual([]);
    expect(snapshot.scroll?.containersTruncated).toBe(true);
  });
});
