import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createSidebarListMotion } from "./Sidebar.motion";

class TestAnimation {
  progress: number | null = 0;
  playState: AnimationPlayState = "running";
  effect = { getComputedTiming: () => ({ progress: this.progress }) };
  cancel = vi.fn(() => {
    this.playState = "idle";
  });
  private onFinish: (() => void) | undefined;
  addEventListener(_type: string, listener: () => void) {
    this.onFinish = listener;
  }
  finish() {
    this.playState = "finished";
    this.onFinish?.();
  }
}

class TestRow {
  offsetTop = 0;
  offsetLeft = 4;
  offsetWidth = 260;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  dragTranslate = 0;
  style: Record<string, string> = {};
  inert = false;
  attributes: { name: string; value: string }[] = [];
  children: TestRow[] = [];
  clones: TestRow[] = [];
  remove = vi.fn();
  animations: TestAnimation[] = [];
  constructor(
    readonly name: string,
    public offsetHeight = 82,
  ) {}
  getBoundingClientRect() {
    return { top: this.offsetTop + this.dragTranslate, height: this.offsetHeight };
  }
  setAttribute(name: string, value: string) {
    this.removeAttribute(name);
    this.attributes.push({ name, value });
  }
  removeAttribute(name: string) {
    this.attributes = this.attributes.filter((attribute) => attribute.name !== name);
  }
  querySelectorAll(_selector: string): TestRow[] {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
  }
  cloneNode(_deep: boolean): TestRow {
    const clone = new TestRow(`${this.name} clone`, this.offsetHeight);
    clone.namespaceURI = this.namespaceURI;
    clone.style = { ...this.style };
    clone.attributes = this.attributes.map((attribute) => ({ ...attribute }));
    clone.children = this.children.map((child) => child.cloneNode(true));
    this.clones.push(clone);
    return clone;
  }
  animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
    const animation = new TestAnimation();
    this.animations.push(animation);
    return animation;
  });
}

function fixture(rows: TestRow[]) {
  const media = { matches: false };
  const parent = {
    children: rows,
    ownerDocument: { defaultView: { matchMedia: () => media } },
    getBoundingClientRect: () => ({ top: 0 }),
    append(node: TestRow) {
      parent.children.push(node);
      node.remove.mockImplementation(() => {
        parent.children = parent.children.filter((child) => child !== node);
      });
    },
  };
  function layout(next: TestRow[]) {
    let top = 8;
    for (const row of next) {
      row.offsetTop = top;
      top += row.offsetHeight + 1;
    }
    parent.children = [
      ...next,
      ...parent.children.filter((row) => row.style.position === "absolute"),
    ];
  }
  layout(rows);
  const motion = createSidebarListMotion(parent as unknown as HTMLUListElement);
  return { motion, layout, media, parent };
}

function expectMove(row: TestRow, offset: number) {
  expect(row.animate).toHaveBeenLastCalledWith(
    [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0px)" }],
    { duration: 150, easing: "ease-out" },
  );
}

beforeEach(() => vi.stubGlobal("HTMLElement", TestRow));
afterEach(() => vi.unstubAllGlobals());

describe("sidebar list motion", () => {
  it("moves a retained Active row into Settled with its displaced peers", () => {
    const pinnedHeader = new TestRow("Pinned", 0);
    const pinned = new TestRow("pin");
    const divider = new TestRow("Active", 0);
    const a = new TestRow("a");
    const b = new TestRow("b");
    const settledHeader = new TestRow("Settled", 32);
    const settled = new TestRow("settled", 36);
    const rows = [pinnedHeader, pinned, divider, a, b, settledHeader, settled];
    const { motion, layout } = fixture(rows);
    motion.update(true);
    expect(rows.every((row) => row.animations.length === 0)).toBe(true);

    a.offsetHeight = 36;
    layout([pinnedHeader, pinned, divider, b, settledHeader, settled, a]);
    motion.update(true);
    expectMove(a, -153);
    expectMove(b, 83);
    expectMove(settledHeader, 83);
    expectMove(settled, 83);
    expect(pinned.animate).not.toHaveBeenCalled();
    expect(divider.animate).not.toHaveBeenCalled();
  });

  it("refreshes the drop baseline without replay and animates the next ordinary move", () => {
    const [a, b, c] = [new TestRow("a"), new TestRow("b"), new TestRow("c")];
    const { motion, layout } = fixture([a, b, c]);
    motion.update(true);
    motion.suspend();
    a.dragTranslate = 300;
    b.dragTranslate = -83;
    motion.update(false);
    motion.suspend();
    layout([b, a, c]);
    a.dragTranslate = b.dragTranslate = 0;
    motion.update(true);
    expect([a, b, c].every((row) => row.animations.length === 0)).toBe(true);

    layout([c, b, a]);
    motion.update(true);
    expectMove(c, 166);
    expectMove(b, -83);
    expectMove(a, -83);
  });

  it("glides every row from its released position into its committed slot", () => {
    const [a, b, c] = [new TestRow("a"), new TestRow("b"), new TestRow("c")];
    const { motion, layout } = fixture([a, b, c]);
    motion.update(true);
    motion.suspend();
    // a is lifted 130px below its slot; b previews upward into a's place
    // and c holds a 16px label gap open below the divider.
    a.dragTranslate = 130;
    b.dragTranslate = -83;
    c.dragTranslate = 16;
    motion.update(false);
    motion.release();
    layout([b, a, c]);
    a.dragTranslate = b.dragTranslate = c.dragTranslate = 0;
    motion.update(true);
    // Lifted top 138, committed slot top 91: glide the remaining 47px.
    expectMove(a, 47);
    // b already sits where it lands; c closes its 16px gap.
    expect(b.animations).toHaveLength(0);
    expectMove(c, 16);
  });

  it("does not glide on release when motion is reduced", () => {
    const [a, b] = [new TestRow("a"), new TestRow("b")];
    const { motion, layout, media } = fixture([a, b]);
    motion.update(true);
    media.matches = true;
    a.dragTranslate = 100;
    motion.release();
    layout([b, a]);
    a.dragTranslate = 0;
    motion.update(true);
    expect(a.animations).toHaveLength(0);
    expect(b.animations).toHaveLength(0);
  });

  it("does not carry a canceled drag's transformed position into the next move", () => {
    const a = new TestRow("a");
    const b = new TestRow("b");
    const { motion, layout } = fixture([a, b]);
    motion.update(true);
    motion.suspend();
    a.dragTranslate = 500;
    b.dragTranslate = -83;
    motion.update(false);
    motion.suspend();
    a.dragTranslate = b.dragTranslate = 0;
    motion.update(true);
    expect(a.animate).not.toHaveBeenCalled();
    expect(b.animate).not.toHaveBeenCalled();

    layout([b, a]);
    motion.update(true);
    expectMove(a, -83);
    expectMove(b, 83);
  });

  it("retargets rapid changes from the current visual position", () => {
    const [a, b, c] = [new TestRow("a", 99), new TestRow("b", 99), new TestRow("c", 99)];
    const { motion, layout } = fixture([a, b, c]);
    motion.update(true);
    layout([b, c, a]);
    motion.update(true);
    expectMove(a, -200);
    const first = a.animations[0]!;
    first.progress = 0.25;

    layout([b, a, c]);
    motion.update(true);
    expect(first.cancel).toHaveBeenCalledOnce();
    expectMove(a, -50);
    first.finish();
    motion.suspend();
    expect(a.animations[1]!.cancel).toHaveBeenCalledOnce();
  });

  it("keeps an uninterrupted movement when the layout position does not change", () => {
    const a = new TestRow("a");
    const b = new TestRow("b");
    const { motion, layout } = fixture([a, b]);
    motion.update(true);
    layout([b, a]);
    motion.update(true);
    a.animations[0]!.progress = 0.5;
    motion.update(true);
    expect(a.animate).toHaveBeenCalledOnce();
    expect(a.animations[0]!.cancel).not.toHaveBeenCalled();
  });

  it("cancels owned motion on suspension and never animates a disposed list", () => {
    const a = new TestRow("a");
    const b = new TestRow("b");
    const { motion, layout } = fixture([a, b]);
    motion.update(true);
    layout([b, a]);
    motion.update(true);
    motion.suspend();
    expect(a.animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(b.animations[0]!.cancel).toHaveBeenCalledOnce();
    motion.update(false);
    layout([a, b]);
    motion.update(true);
    motion.dispose();
    expect(a.animations[1]!.cancel).toHaveBeenCalledOnce();
    layout([b, a]);
    motion.update(true);
    expect(a.animate).toHaveBeenCalledTimes(2);
  });

  it("fades a collapsed-shelf exit at its current visual box and a new wake in", () => {
    const a = new TestRow("a");
    const b = new TestRow("b");
    const fresh = new TestRow("new");
    a.setAttribute("data-thread-item", "a");
    a.children = [new TestRow("button")];
    a.children[0]!.setAttribute("id", "thread-control");
    a.children[0]!.setAttribute("data-testid", "thread-control");
    a.children[0]!.setAttribute("data-state", "open");
    const icon = new TestRow("provider icon");
    icon.namespaceURI = "http://www.w3.org/2000/svg";
    icon.setAttribute("id", "provider-mask");
    icon.setAttribute("mask", "url(#provider-mask)");
    a.children.push(icon);
    const { motion, layout, parent } = fixture([a, b]);
    motion.update(true);
    layout([b, a]);
    motion.update(true);
    a.animations[0]!.progress = 0.5;
    layout([b, fresh]);
    motion.update(true);
    expect(a.animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(fresh.animate).toHaveBeenLastCalledWith([{ opacity: 0 }, { opacity: 1 }], {
      duration: 150,
      easing: "ease-out",
    });
    const clone = a.clones[0]!;
    expect(clone.style).toMatchObject({
      position: "absolute",
      top: "49.5px",
      left: "4px",
      width: "260px",
      height: "82px",
      transform: "none",
      pointerEvents: "none",
    });
    expect(clone.inert).toBe(true);
    expect(clone.attributes).toEqual([{ name: "aria-hidden", value: "true" }]);
    expect(clone.children[0]!.attributes).toEqual([{ name: "data-state", value: "open" }]);
    expect(clone.children[1]!.attributes).toEqual(icon.attributes);
    expect(clone.animate).toHaveBeenCalledWith([{ opacity: 1 }, { opacity: 0 }], {
      duration: 150,
      easing: "ease-out",
    });
    expect(parent.children.includes(clone)).toBe(true);
    motion.update(true);
    expect(clone.animations).toHaveLength(1);
    expect(clone.clones).toHaveLength(0);
    clone.animations[0]!.finish();
    expect(parent.children.includes(clone)).toBe(false);
  });

  it("clears exit clones on pickup and does not fade the release commit", () => {
    const [a, b, c] = [new TestRow("a"), new TestRow("b"), new TestRow("c")];
    const { motion, layout, parent } = fixture([a, b]);
    motion.update(false);
    layout([b]);
    motion.update(true);
    const clone = a.clones[0]!;
    motion.suspend();
    expect(clone.animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(parent.children.includes(clone)).toBe(false);
    motion.update(false);
    motion.suspend();
    layout([c]);
    motion.update(true);
    expect(b.clones).toHaveLength(0);
    expect(c.animations).toHaveLength(0);
    layout([c, a]);
    motion.update(true);
    expect(a.animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], {
      duration: 150,
      easing: "ease-out",
    });
    motion.dispose();
    expect(a.animations.at(-1)!.cancel).toHaveBeenCalledOnce();
  });

  it("carries entry opacity into a quick exit and removes artifacts on a silent update", () => {
    const a = new TestRow("a");
    const marker = new TestRow("boundary", 0);
    const { motion, layout, parent } = fixture([marker]);
    motion.update(false);
    layout([marker, a]);
    motion.update(true);
    a.animations[0]!.progress = 0.4;
    layout([]);
    motion.update(true);
    expect(marker.clones).toHaveLength(0);
    const clone = a.clones[0]!;
    expect(clone.animate).toHaveBeenCalledWith([{ opacity: 0.4 }, { opacity: 0 }], {
      duration: 150,
      easing: "ease-out",
    });
    motion.update(false);
    expect(parent.children).toEqual([]);
    expect(clone.animations[0]!.cancel).toHaveBeenCalledOnce();
  });

  it("respects reduced motion while keeping the next baseline fresh", () => {
    const a = new TestRow("a");
    const b = new TestRow("b");
    const { motion, layout, media } = fixture([a, b]);
    motion.update(true);
    media.matches = true;
    layout([b, a]);
    motion.update(true);
    expect(a.animate).not.toHaveBeenCalled();
    media.matches = false;
    layout([a, b]);
    motion.update(true);
    expectMove(a, 83);
    expectMove(b, -83);
  });
});
