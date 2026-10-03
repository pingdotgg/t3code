import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { measureContextStrip } from "./contextStripMeasurement";

/**
 * A strip row with the composer's resting controls docked beside its labels.
 *
 * Widths are the laid-out ones a real strip produces, so the reservation the
 * measurement makes for the hosted controls is read from a host that exists
 * rather than asserted against a number.
 */
class FakeElement {
  children: FakeElement[] = [];
  found = new Map<string, FakeElement[]>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  textNodes: FakeElement[] = [];
  offsetWidth = 0;
  clientWidth = 0;
  scrollWidth = 0;
  rectWidth = 0;
  textWidth = 0;
  hostSelector: string | null = null;

  matches(selector: string): boolean {
    return this.hostSelector === selector;
  }
  querySelector<T>(selector: string): T | null {
    return (this.found.get(selector)?.[0] as T | undefined) ?? null;
  }
  querySelectorAll<T>(selector: string): T[] {
    return (this.found.get(selector) ?? []) as T[];
  }
  getBoundingClientRect(): DOMRect {
    return { width: this.rectWidth } as DOMRect;
  }
}

/** Picker 52 + block 140 + one gap. The overflow trigger only counts once
 * something actually moves into it, so nothing hidden here adds to it. */
function buildControls(): FakeElement {
  const picker = new FakeElement();
  picker.rectWidth = 52;
  picker.style.minWidth = "52px";
  // A deliberately collapsed label (`w-0`, `flex-none`) needs no width recovered.
  const pickerLabel = new FakeElement();
  pickerLabel.clientWidth = 0;
  pickerLabel.scrollWidth = 160;
  pickerLabel.style.flexGrow = "0";
  picker.found.set('[data-chat-provider-model-picker-label="true"]', [pickerLabel]);

  const block = new FakeElement();
  block.rectWidth = 140;

  const overflow = new FakeElement();
  overflow.rectWidth = 24;

  const controls = new FakeElement();
  controls.style.columnGap = "4px";
  controls.found.set("[data-chat-provider-model-picker]", [picker]);
  controls.found.set("[data-resting-controls-overflow]", [overflow]);
  controls.found.set("[data-resting-block]", [block]);
  return controls;
}

/** The strip's `ps-1 pe-2` and, after BranchToolbar's override, `gap-1`. */
const STRIP_PADDING_INLINE = 12;
const STRIP_GAP = 4;
const ICON_WIDTH = 16;
const LABEL_TEXT_WIDTH = 100;
const CONTROLS_NATURAL_WIDTH = 196;

/**
 * `compact` collapses the label the way the compact styles do: the icon stays,
 * the text box shrinks to nothing while its text keeps its natural width.
 */
function buildStrip(compact: boolean): FakeElement {
  const labelShown = compact ? 0 : LABEL_TEXT_WIDTH;

  const labelText = new FakeElement();
  labelText.textWidth = LABEL_TEXT_WIDTH;
  const label = new FakeElement();
  label.rectWidth = labelShown;
  label.textNodes = [labelText];

  const trigger = new FakeElement();
  trigger.offsetWidth = ICON_WIDTH + labelShown;
  trigger.found.set("[data-composer-label]", [label]);

  const contextGroup = new FakeElement();
  contextGroup.children = [trigger];

  const host = new FakeElement();
  host.hostSelector = '[data-chat-resting-composer-controls-host="true"]';
  host.found.set('[data-chat-composer-resting-controls="true"]', [buildControls()]);

  const strip = new FakeElement();
  strip.style.paddingInlineStart = "4px";
  strip.style.paddingInlineEnd = "8px";
  strip.style.columnGap = `${String(STRIP_GAP)}px`;
  strip.clientWidth = 724;
  strip.children = [contextGroup, host];
  strip.found.set("[data-composer-label]", [label]);

  return strip;
}

function stubDom(root: FakeElement) {
  const styles = new WeakMap<object, Record<string, string>>();
  const textWidths = new WeakMap<object, number>();
  const textNodes = new WeakMap<object, FakeElement[]>();
  const visited = new Set<object>();
  const visit = (node: FakeElement) => {
    if (visited.has(node)) return;
    visited.add(node);
    styles.set(node, node.style);
    textWidths.set(node, node.textWidth);
    textNodes.set(node, node.textNodes);
    for (const child of node.children) visit(child);
    for (const text of node.textNodes) visit(text);
    for (const found of node.found.values()) {
      for (const item of found) visit(item);
    }
  };
  visit(root);

  class FakeRange {
    private node: object | null = null;
    selectNodeContents(node: object) {
      this.node = node;
    }
    getBoundingClientRect() {
      return { width: textWidths.get(this.node ?? {}) ?? 0 };
    }
  }

  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
  vi.stubGlobal("document", {
    createRange: () => new FakeRange(),
    createTreeWalker: (root: object) => {
      const nodes = textNodes.get(root) ?? [];
      let next = 0;
      return { nextNode: () => (nodes[next] ? (nodes[next++] as unknown as Node) : null) };
    },
  });
  vi.stubGlobal("getComputedStyle", (element: object) => styles.get(element) ?? {});
}

function measure(compact: boolean) {
  const strip = buildStrip(compact);
  stubDom(strip);
  return measureContextStrip(strip as unknown as HTMLElement)!;
}

afterEach(() => vi.unstubAllGlobals());

describe("measureContextStrip", () => {
  it("does not count the strip's own padding as room for its children", () => {
    // Counting it opens a band exactly the padding wide where the strip keeps
    // its labels while the docked controls have already collapsed to icons.
    expect(measure(true).availableWidth).toBe(724 - STRIP_PADDING_INLINE);
  });

  it("reserves the natural width of the controls, not what they currently show", () => {
    // Reserving only the visible controls lets the labels expand into room the
    // composer just gave up, which shrinks the host and hides them again.
    expect(measure(true).neededWidth).toBe(
      ICON_WIDTH + LABEL_TEXT_WIDTH + CONTROLS_NATURAL_WIDTH + STRIP_GAP,
    );
  });

  it("asks for the same width whether the labels show or only their icons do", () => {
    // Otherwise the strip reads its own compact state as freed room and
    // expands again on the next pass.
    expect(measure(true).neededWidth).toBe(measure(false).neededWidth);
  });

  it("keeps the caller's answer while the row has no layout", () => {
    const strip = buildStrip(false);
    strip.clientWidth = 0;
    stubDom(strip);
    expect(measureContextStrip(strip as unknown as HTMLElement)).toBeNull();
  });
});
