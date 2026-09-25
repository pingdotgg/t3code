import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveContextStripLabelsCompact } from "../BranchToolbar.logic";
import { measureContextStrip } from "./contextStripMeasurement";
import { measureRestingComposerControls } from "./restingComposerControlsMeasurement";
import {
  resolveRestingComposerControlsLayout,
  resolveRestingComposerControlsNaturalWidth,
} from "../composerFooterLayout";
import { contentInlineWidth } from "../../lib/contentInlineWidth";

/**
 * A strip row whose widths are derived the way flex derives them, so the
 * composer's host width is a consequence of the strip's own layout rather than a
 * number in this file. That coupling is the point: the strip decides whether its
 * labels fit, the composer decides how many resting controls fit in the host the
 * strip hands it, and the two have to agree at every width.
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

/** The composer's resting controls: a model picker and one labeled block. */
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

const STRIP_PADDING_INLINE = 12;
const STRIP_GAP = 8;
const ICON_WIDTH = 16;
const LABEL_TEXT_WIDTH = 100;

interface Strip {
  element: FakeElement;
  host: FakeElement;
  controls: FakeElement;
}

/**
 * Lay the row out at a given strip width. `compact` collapses the label the way
 * the compact styles do: the icon stays, the text box shrinks to nothing while
 * its text keeps its natural width for the next measurement.
 */
function buildStrip(stripWidth: number, compact: boolean): Strip {
  const labelShown = compact ? 0 : LABEL_TEXT_WIDTH;

  const labelText = new FakeElement();
  labelText.textWidth = LABEL_TEXT_WIDTH;
  const label = new FakeElement();
  label.rectWidth = labelShown;
  label.textNodes = [labelText];

  // The control the label lives inside, laid out at its visible width.
  const trigger = new FakeElement();
  trigger.offsetWidth = ICON_WIDTH + labelShown;
  trigger.found.set("[data-composer-label]", [label]);

  const contextGroup = new FakeElement();
  contextGroup.children = [trigger];

  const controls = buildControls();
  const host = new FakeElement();
  host.hostSelector = '[data-chat-resting-composer-controls-host="true"]';
  host.found.set('[data-chat-composer-resting-controls="true"]', [controls]);
  // Flex gives the host whatever the other groups leave over.
  host.clientWidth = stripWidth - STRIP_PADDING_INLINE - STRIP_GAP - trigger.offsetWidth;

  const strip = new FakeElement();
  strip.style.paddingInlineStart = "4px";
  strip.style.paddingInlineEnd = "8px";
  strip.style.columnGap = `${String(STRIP_GAP)}px`;
  strip.clientWidth = stripWidth;
  strip.children = [contextGroup, host];
  strip.found.set("[data-composer-label]", [label]);

  return { element: strip, host, controls };
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

/** What the strip and the composer each conclude about the same row. */
function probe(stripWidth: number, compact: boolean) {
  const strip = buildStrip(stripWidth, compact);
  stubDom(strip.element);

  const measured = measureContextStrip(strip.element as unknown as HTMLElement)!;
  const measurement = measureRestingComposerControls(strip.controls as unknown as HTMLElement)!;
  const hostWidth = contentInlineWidth(strip.host as unknown as HTMLElement);
  const layout = resolveRestingComposerControlsLayout({ ...measurement, hostWidth });

  return {
    availableWidth: measured.availableWidth,
    neededWidth: measured.neededWidth,
    hostWidth,
    controlsNaturalWidth: resolveRestingComposerControlsNaturalWidth(measurement),
    stripCompact: resolveContextStripLabelsCompact({
      compact,
      neededWidth: measured.neededWidth,
      availableWidth: measured.availableWidth,
    }),
    controlsCompacted:
      Boolean(layout.hiddenCount) || Boolean(layout.iconOnlyCount) || !layout.visible,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("measureContextStrip", () => {
  it("does not count the strip's own padding as room for its children", () => {
    expect(probe(724, true).availableWidth).toBe(724 - STRIP_PADDING_INLINE);
  });

  it("reserves the natural width of the controls hosted beside the labels", () => {
    const result = probe(724, true);
    expect(result.controlsNaturalWidth).toBe(196);
    expect(result.neededWidth).toBe(
      ICON_WIDTH + LABEL_TEXT_WIDTH + result.controlsNaturalWidth + STRIP_GAP,
    );
  });

  it("asks for the same width whether the labels show or only their icons do", () => {
    // Otherwise the strip reads its own compact state as freed room and expands
    // again on the next pass.
    expect(probe(724, true).neededWidth).toBe(probe(724, false).neededWidth);
  });

  it("keeps the caller's answer while the row has no layout", () => {
    const strip = buildStrip(0, false);
    stubDom(strip.element);
    expect(measureContextStrip(strip.element as unknown as HTMLElement)).toBeNull();
  });

  it("holds the labels compact until the hysteresis margin clears", () => {
    const needed = probe(724, true).neededWidth;
    const decide = (extra: number, compact: boolean) =>
      probe(needed + STRIP_PADDING_INLINE + extra, compact).stripCompact;
    expect(decide(0, false)).toBe(false);
    expect(decide(0, true)).toBe(true);
    expect(decide(16, true)).toBe(false);
  });
});

describe("context strip and resting composer controls", () => {
  it("never collapses the labels and the hosted controls at the same time", () => {
    // The band this guards is exactly the strip's inline padding: counting that
    // padding as free space lets the strip keep its labels while the host beside
    // them is already too narrow, so the controls drop to icons. Sweeping every
    // width closes the whole class instead of the one reported width, and holds
    // for both label states because the strip re-decides from its own state.
    const broken: number[] = [];
    for (let width = 240; width <= 480; width += 1) {
      for (const compact of [false, true]) {
        const result = probe(width, compact);
        if (!result.stripCompact && result.controlsCompacted) broken.push(width);
      }
    }
    expect(broken).toEqual([]);
  });
});
