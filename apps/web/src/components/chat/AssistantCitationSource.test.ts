import type { LegendListRef } from "@legendapp/list/react";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  observeAssistantCitationCommentSource,
  observeAssistantCitationSource,
  type AssistantCitationTarget,
} from "./AssistantCitationSource";

const mocks = vi.hoisted(() => ({ resolveRange: vi.fn(), toast: vi.fn() }));
vi.mock("~/lib/assistantTextSelection", () => ({
  resolveAssistantCitationRange: mocks.resolveRange,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

function rect(top: number, height = 20) {
  return { top, bottom: top + height, height, width: 100 } as DOMRect;
}

class TestAnimation {
  currentTime = 0;
  id = "";
  private resolveFinished!: () => void;
  finished = new Promise<void>((resolve) => {
    this.resolveFinished = resolve;
  });
  cancel = vi.fn();
  finish() {
    this.resolveFinished();
  }
}

class TestElement {
  parentNode: TestElement | null = null;
  dataset: Record<string, string> = {};
  focus = vi.fn();
  animations: TestAnimation[] = [];
  animate = vi.fn(() => {
    const animation = new TestAnimation();
    this.animations.push(animation);
    return animation as unknown as Animation;
  });
  isConnected = true;
  scrollTop = 8586;
  scrollHeight = 9334;
  clientHeight = 748;
  getBoundingClientRect = () => rect(0, this.clientHeight);
  ownerDocument = {
    getSelection: () => null as TestSelection | null,
  };

  contains(node: TestElement | null): boolean {
    return node === this || (node?.parentNode ? this.contains(node.parentNode) : false);
  }
}

class TestRange {
  startOffset = 0;
  endOffset = 5;
  collapsed = false;
  endContainer: TestElement;

  constructor(
    public startContainer: TestElement,
    readonly readRect: () => DOMRect,
  ) {
    this.endContainer = startContainer;
  }

  getBoundingClientRect() {
    return this.collapsed ? rect(0, 0) : this.readRect();
  }

  cloneRange() {
    const copy = new TestRange(this.startContainer, this.readRect);
    copy.startOffset = this.startOffset;
    copy.endOffset = this.endOffset;
    return copy;
  }

  collapseTo(parent: TestElement) {
    this.startContainer = this.endContainer = parent;
    this.startOffset = this.endOffset = 0;
    this.collapsed = true;
  }

  setStart(node: TestElement, offset: number) {
    this.startContainer = node;
    this.startOffset = offset;
    this.collapsed =
      this.startContainer === this.endContainer && this.startOffset === this.endOffset;
  }

  setEnd(node: TestElement, offset: number) {
    this.endContainer = node;
    this.endOffset = offset;
    this.collapsed =
      this.startContainer === this.endContainer && this.startOffset === this.endOffset;
  }

  toString() {
    return this.collapsed ? "" : "quote";
  }
}

class TestSelection {
  ranges: TestRange[] = [];
  get rangeCount() {
    return this.ranges.length;
  }
  getRangeAt(index: number) {
    return this.ranges[index]!;
  }
  addRange(range: TestRange) {
    this.ranges.push(range);
  }
  removeRange(range: TestRange) {
    this.ranges = this.ranges.filter((current) => current !== range);
  }
  removeAllRanges() {
    this.ranges = [];
  }
}

function createSource({ reducedMotion = false } = {}) {
  vi.stubGlobal("window", { matchMedia: vi.fn(() => ({ matches: reducedMotion })) });
  let now = 0;
  vi.stubGlobal("performance", { now: () => now });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
  const flushFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  };
  const mutationCallbacks = new Set<MutationCallback>();
  let resize: ResizeObserverCallback = () => {};
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(readonly callback: MutationCallback) {}
      observe() {
        mutationCallbacks.add(this.callback);
      }
      disconnect() {
        mutationCallbacks.delete(this.callback);
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {
        resize = () => {};
      }
    },
  );
  vi.stubGlobal("HTMLElement", TestElement);
  const highlights = new Map<string, Set<TestRange>>();
  vi.stubGlobal(
    "Highlight",
    class extends Set<TestRange> {
      constructor(...ranges: TestRange[]) {
        super(ranges);
      }
    },
  );
  vi.stubGlobal("CSS", { highlights });

  const scrollNode = new TestElement();
  const container = new TestElement();
  container.parentNode = scrollNode;
  const root = new TestElement();
  root.parentNode = container;
  const text = new TestElement();
  text.parentNode = root;
  let sourceTop = 200;
  let measured = true;
  let rangeHeight = 20;
  root.getBoundingClientRect = () => rect(sourceTop - scrollNode.scrollTop, 300);
  mocks.resolveRange.mockImplementation(
    () => new TestRange(text, () => rect(sourceTop - scrollNode.scrollTop, rangeHeight)),
  );
  const listeners = new Set<() => void>();
  const listen = (callback: () => void) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  };
  const layoutChanged = () => {
    for (const listener of listeners) listener();
  };
  let pending: { options: { offset: number }; resolve: () => void } | null = null;
  const scrollToOffset = vi.fn((options: { offset: number; animated?: boolean }) => {
    pending?.resolve();
    return new Promise<void>((resolve) => {
      pending = { options, resolve };
    });
  });
  const finishScroll = async () => {
    const scroll = pending;
    if (!scroll) throw new Error("No citation scroll is pending");
    pending = null;
    scrollNode.scrollTop = scroll.options.offset;
    scroll.resolve();
    await Promise.resolve();
    flushFrame();
  };
  const list = {
    getScrollableNode: () => scrollNode,
    getState: () => ({
      scroll: scrollNode.scrollTop,
      indexByKey: () => 1,
      sizeAtIndex: () => (measured ? 300 : undefined),
      listenToPosition: (_key: string, callback: () => void) => listen(callback),
      listen: (_signal: string, callback: () => void) => listen(callback),
    }),
    scrollToOffset,
  } as unknown as LegendListRef;
  const target: AssistantCitationTarget = {
    key: "activation-one",
    citation: {
      version: 1,
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("source"),
      text: "quote",
      start: 0,
      end: 5,
      prefix: "",
      suffix: "",
    },
    activationRef: { current: { scrolled: false, dismissed: false } },
    onComplete: vi.fn(),
  };
  const cleanups: Array<() => void> = [];
  const mount = (request = target) => {
    const cleanup = observeAssistantCitationSource({
      root: root as unknown as HTMLElement,
      itemKey: "source-row",
      request,
      list,
    });
    if (cleanup) cleanups.push(cleanup);
    return cleanup;
  };
  const mountComment = (
    range = new TestRange(text, () => rect(sourceTop - scrollNode.scrollTop, rangeHeight)),
  ) => {
    const onUnavailable = vi.fn();
    const cleanup = observeAssistantCitationCommentSource({
      anchor: {
        source: root as unknown as HTMLElement,
        range: range as unknown as Range,
        viewport: scrollNode as unknown as HTMLElement,
      },
      citation: target.citation,
      onUnavailable,
    });
    cleanups.push(cleanup);
    return { range, onUnavailable, cleanup };
  };
  const mutation = (changed: TestElement, removed: TestElement[] = []) => {
    for (const callback of mutationCallbacks) {
      callback(
        [{ target: changed, addedNodes: [], removedNodes: removed }] as unknown as MutationRecord[],
        {} as MutationObserver,
      );
    }
  };
  return {
    target,
    root,
    text,
    container,
    scrollNode,
    highlights,
    scrollToOffset,
    mount,
    mountComment,
    flushFrame,
    finishScroll,
    layoutChanged,
    mutation,
    advanceTime: (milliseconds: number) => {
      now += milliseconds;
    },
    finishPulse: async () => {
      root.animations.at(-1)?.finish();
      await Promise.resolve();
    },
    resize: () => resize([], {} as ResizeObserver),
    setMeasured: (value: boolean) => {
      measured = value;
    },
    setRangeHeight: (value: number) => {
      rangeHeight = value;
    },
    setSourceTop: (value: number) => {
      sourceTop = value;
    },
    highlight: () => highlights.get("t3-assistant-citation")?.values().next().value,
    commentHighlight: () => highlights.get("t3-assistant-citation-comment"),
    cleanup: () => {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("assistant citation source lifecycle", () => {
  it("waits for a mounted measurement and rechecks geometry after the list settles", async () => {
    const source = createSource();
    source.setMeasured(false);
    source.mount();
    source.flushFrame();
    expect(source.scrollToOffset).not.toHaveBeenCalled();

    source.setMeasured(true);
    source.setRangeHeight(0);
    source.resize();
    source.flushFrame();
    expect(source.target.activationRef.current.scrolled).toBe(false);
    expect(source.scrollToOffset).not.toHaveBeenCalled();

    source.setRangeHeight(20);
    source.layoutChanged();
    source.flushFrame();
    expect(source.scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 80, animated: true });
    expect(source.highlight()).toBeUndefined();
    expect(source.root.animations).toHaveLength(0);

    source.scrollNode.scrollTop = 4200;
    source.advanceTime(700);
    source.setSourceTop(260);
    source.layoutChanged();
    source.flushFrame();
    expect(source.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(source.highlight()).toBeUndefined();
    expect(source.target.onComplete).not.toHaveBeenCalled();
    await source.finishScroll();
    expect(source.target.onComplete).not.toHaveBeenCalled();
    expect(source.scrollToOffset).toHaveBeenLastCalledWith({ offset: 140, animated: true });
    await source.finishScroll();
    expect(source.target.onComplete).toHaveBeenCalledOnce();
    expect(source.highlight()?.getBoundingClientRect().top).toBe(120);
    expect(source.root.animations).toHaveLength(1);
    expect(source.root.focus).not.toHaveBeenCalled();
    source.cleanup();
    expect(source.highlight()).toBeUndefined();
  });

  it("completes a measured citation at the clamped beginning of the list", async () => {
    const source = createSource();
    source.setSourceTop(40);
    source.mount();
    source.flushFrame();
    await source.finishScroll();
    expect(source.scrollNode.scrollTop).toBe(0);
    expect(source.highlight()?.toString()).toBe("quote");
    expect(source.target.onComplete).toHaveBeenCalledOnce();
    source.cleanup();
  });

  it("repairs collapsed ranges after an ancestor move without following the user's scroll", async () => {
    const source = createSource();
    const unmount = source.mount();
    source.flushFrame();
    await source.finishScroll();
    const originalRange = source.highlight()!;
    source.scrollNode.scrollTop = 4000;
    originalRange.collapseTo(source.scrollNode);
    source.mutation(source.scrollNode, [source.container]);
    expect(source.highlight()).toBeUndefined();
    expect(source.root.dataset.citationHighlighted).toBeUndefined();
    source.flushFrame();
    expect(source.highlight()?.toString()).toBe("quote");
    expect(source.root.contains(source.highlight()!.startContainer)).toBe(true);
    expect(source.scrollNode.scrollTop).toBe(4000);
    expect(source.root.animations).toHaveLength(1);

    const resolutions = mocks.resolveRange.mock.calls.length;
    source.mutation(new TestElement());
    source.flushFrame();
    expect(mocks.resolveRange).toHaveBeenCalledTimes(resolutions);

    unmount?.();
    source.advanceTime(700);
    source.mount();
    source.flushFrame();
    expect(source.highlight()?.toString()).toBe("quote");
    expect(source.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(source.target.onComplete).toHaveBeenCalledOnce();
    expect(source.root.animations).toHaveLength(2);
    expect(source.root.animations[1]?.currentTime).toBe(700);
    source.root.animations[0]?.finish();
    await Promise.resolve();
    expect(source.highlight()?.toString()).toBe("quote");
    await source.finishPulse();
    expect(source.highlight()).toBeUndefined();
    source.cleanup();
  });

  it("removes the quote after the pulse and replays it only for a fresh citation activation", async () => {
    const source = createSource();
    const unmount = source.mount();
    source.flushFrame();
    await source.finishScroll();
    await source.finishPulse();
    expect(source.highlight()).toBeUndefined();
    expect(source.root.dataset.citationHighlighted).toBeUndefined();
    source.layoutChanged();
    source.flushFrame();
    expect(source.mount()).toBeUndefined();
    expect(source.root.animations).toHaveLength(1);

    unmount?.();
    source.mount({
      ...source.target,
      key: "activation-two",
      activationRef: { current: { scrolled: false, dismissed: false } },
    });
    source.flushFrame();
    expect(source.highlight()?.toString()).toBe("quote");
    expect(source.root.animations).toHaveLength(2);
    expect(source.root.animations[1]?.currentTime).toBe(0);
    source.cleanup();
  });

  it("uses instant navigation and removes the temporary quote highlight for reduced motion", async () => {
    const source = createSource({ reducedMotion: true });
    source.mount();
    source.flushFrame();
    expect(source.scrollToOffset).toHaveBeenCalledWith({ offset: 80, animated: false });
    expect(source.highlight()).toBeUndefined();
    await source.finishScroll();
    expect(source.target.activationRef.current.pulse?.reducedMotion).toBe(true);
    expect(source.highlight()?.toString()).toBe("quote");
    await source.finishPulse();
    expect(source.highlight()).toBeUndefined();
    expect(source.root.focus).not.toHaveBeenCalled();
    source.cleanup();
  });

  it("does not revive a quote when remounting after its original pulse deadline", async () => {
    const source = createSource();
    const unmount = source.mount();
    source.flushFrame();
    await source.finishScroll();
    unmount?.();
    source.advanceTime(3100);
    source.mount();
    source.flushFrame();
    expect(source.highlight()).toBeUndefined();
    expect(source.root.animations).toHaveLength(1);
    expect(source.target.activationRef.current.dismissed).toBe(true);
    source.cleanup();
  });

  it("dismisses an active text pulse without reviving it on remount", async () => {
    const source = createSource();
    source.mount();
    source.flushFrame();
    await source.finishScroll();
    source.target.activationRef.current.dismissed = true;
    source.cleanup();
    expect(source.root.animations[0]?.cancel).toHaveBeenCalledOnce();
    expect(source.highlight()).toBeUndefined();
    expect(source.mount()).toBeUndefined();
    source.flushFrame();
    expect(source.root.animations).toHaveLength(1);
  });

  it("does not highlight a parent when the saved quote no longer matches", async () => {
    const source = createSource();
    mocks.resolveRange.mockReturnValue(null);
    source.mount();
    source.flushFrame();
    await source.finishScroll();
    expect(source.highlight()).toBeUndefined();
    expect(source.root.animations).toHaveLength(0);
    expect(source.root.focus).not.toHaveBeenCalled();
    expect(source.target.onComplete).toHaveBeenCalledOnce();
    source.cleanup();
  });

  it("cancels deferred positioning without capturing a pre-gesture offset or reviving dismissal", async () => {
    const source = createSource();
    source.mount();
    source.flushFrame();
    expect(source.scrollToOffset).toHaveBeenCalledWith({ offset: 80, animated: true });
    source.target.activationRef.current.dismissed = true;
    source.target.activationRef.current.cancelScroll?.();
    source.scrollNode.scrollTop = 4300;
    expect(source.scrollToOffset).toHaveBeenLastCalledWith({ offset: 4300, animated: false });
    await source.finishScroll();
    source.layoutChanged();
    source.flushFrame();
    expect(source.scrollNode.scrollTop).toBe(4300);
    expect(source.target.activationRef.current.scrolled).toBe(false);
    expect(source.target.onComplete).not.toHaveBeenCalled();
    expect(source.highlight()).toBeUndefined();
    expect(source.root.animations).toHaveLength(0);
    source.cleanup();
    expect(source.mount()).toBeUndefined();
    source.flushFrame();
    expect(source.scrollToOffset).toHaveBeenCalledTimes(2);
  });

  it("does not erase another highlight when its source unmounts", async () => {
    const source = createSource();
    source.mount();
    source.flushFrame();
    await source.finishScroll();
    const replacement = new Set<TestRange>();
    source.highlights.set("t3-assistant-citation", replacement);
    source.cleanup();
    expect(source.highlights.get("t3-assistant-citation")).toBe(replacement);
  });

  it("preserves a user's replacement selection in the native-selection fallback", async () => {
    const source = createSource();
    vi.stubGlobal("Highlight", undefined);
    const selection = new TestSelection();
    source.root.ownerDocument.getSelection = () => selection;
    source.mount();
    source.flushFrame();
    await source.finishScroll();
    expect(selection.ranges).toHaveLength(1);
    expect(selection.ranges[0]?.startContainer).toBe(source.text);

    const userRange = new TestRange(new TestElement(), () => rect(50));
    selection.ranges = [userRange];
    source.mutation(source.root);
    source.flushFrame();
    source.cleanup();
    source.mount();
    source.flushFrame();
    expect(selection.ranges).toEqual([userRange]);
    expect(source.scrollToOffset).toHaveBeenCalledTimes(1);
    source.cleanup();
  });

  it("clears its own native-selection fallback when the pulse expires", async () => {
    const source = createSource();
    vi.stubGlobal("Highlight", undefined);
    const selection = new TestSelection();
    source.root.ownerDocument.getSelection = () => selection;
    source.mount();
    source.flushFrame();
    await source.finishScroll();
    expect(selection.ranges).toHaveLength(1);
    await source.finishPulse();
    expect(selection.ranges).toHaveLength(0);
    source.cleanup();
  });
});

describe("assistant citation comment source lifecycle", () => {
  it("keeps the exact live range highlighted until cleanup without changing selection or navigation", () => {
    const source = createSource();
    const selection = new TestSelection();
    const selectedRange = new TestRange(source.text, () => rect(40));
    selection.addRange(selectedRange);
    const getSelection = vi.fn(() => selection);
    source.root.ownerDocument.getSelection = getSelection;
    const navigationHighlight = new Set([new TestRange(source.text, () => rect(20))]);
    source.highlights.set("t3-assistant-citation", navigationHighlight);
    const comment = source.mountComment();

    expect(source.commentHighlight()?.size).toBe(1);
    expect(source.commentHighlight()?.values().next().value).toBe(comment.range);
    expect(mocks.resolveRange).not.toHaveBeenCalled();
    source.advanceTime(5000);
    source.flushFrame();
    expect(source.commentHighlight()?.has(comment.range)).toBe(true);
    expect(source.root.animations).toHaveLength(0);
    expect(source.scrollToOffset).not.toHaveBeenCalled();
    expect(getSelection).not.toHaveBeenCalled();

    comment.cleanup();
    comment.cleanup();
    expect(source.commentHighlight()).toBeUndefined();
    expect(source.highlights.get("t3-assistant-citation")).toBe(navigationHighlight);
    expect(selection.ranges).toEqual([selectedRange]);
    expect(comment.onUnavailable).not.toHaveBeenCalled();
    source.mutation(source.root);
    expect(mocks.resolveRange).not.toHaveBeenCalled();
  });

  it("repairs changed source text in the same Range used by the popup anchor", () => {
    const source = createSource();
    const comment = source.mountComment();
    const replacementText = new TestElement();
    replacementText.parentNode = source.root;
    const repaired = new TestRange(replacementText, () => rect(70));
    repaired.startOffset = 7;
    repaired.endOffset = 12;
    mocks.resolveRange.mockReturnValue(repaired);

    source.mutation(source.root);

    expect(mocks.resolveRange).toHaveBeenCalledOnce();
    expect(comment.range.startContainer).toBe(replacementText);
    expect(comment.range.endContainer).toBe(replacementText);
    expect(comment.range.startOffset).toBe(7);
    expect(comment.range.endOffset).toBe(12);
    expect(comment.range.collapsed).toBe(false);
    expect(source.commentHighlight()?.size).toBe(1);
    expect(source.commentHighlight()?.values().next().value).toBe(comment.range);
    expect(source.commentHighlight()?.has(repaired)).toBe(false);
    expect(comment.onUnavailable).not.toHaveBeenCalled();
    source.cleanup();
  });

  it.each(["collapsed", "escaped"])("repairs a %s range after a virtual ancestor move", (state) => {
    const source = createSource();
    const comment = source.mountComment();
    if (state === "collapsed") {
      comment.range.collapseTo(source.scrollNode);
    } else {
      comment.range.startContainer = new TestElement();
    }

    source.mutation(source.scrollNode, [source.container]);

    expect(comment.range.startContainer).toBe(source.text);
    expect(comment.range.endContainer).toBe(source.text);
    expect(comment.range.collapsed).toBe(false);
    expect(source.commentHighlight()?.has(comment.range)).toBe(true);
    expect(comment.onUnavailable).not.toHaveBeenCalled();
    source.cleanup();
  });

  it("clears and disconnects once when the selected quote can no longer be repaired", () => {
    const source = createSource();
    const comment = source.mountComment();
    mocks.resolveRange.mockReturnValue(null);

    source.mutation(source.root);

    expect(comment.onUnavailable).toHaveBeenCalledOnce();
    expect(source.commentHighlight()).toBeUndefined();
    source.mutation(source.root);
    comment.cleanup();
    expect(mocks.resolveRange).toHaveBeenCalledOnce();
    expect(comment.onUnavailable).toHaveBeenCalledOnce();
  });

  it.each(["disconnected", "outside viewport"])("closes once when the source is %s", (state) => {
    const source = createSource();
    const comment = source.mountComment();
    if (state === "disconnected") {
      source.root.isConnected = false;
    } else {
      source.root.parentNode = new TestElement();
    }

    source.mutation(source.scrollNode, [source.container]);
    source.mutation(source.scrollNode, [source.container]);
    comment.cleanup();

    expect(comment.onUnavailable).toHaveBeenCalledOnce();
    expect(source.commentHighlight()).toBeUndefined();
    expect(mocks.resolveRange).not.toHaveBeenCalled();
  });

  it("rejects an already detached source without registering a highlight", () => {
    const source = createSource();
    source.root.isConnected = false;
    const comment = source.mountComment();

    expect(comment.onUnavailable).toHaveBeenCalledOnce();
    expect(source.commentHighlight()).toBeUndefined();
    source.mutation(source.root);
    comment.cleanup();
    expect(comment.onUnavailable).toHaveBeenCalledOnce();
    expect(mocks.resolveRange).not.toHaveBeenCalled();
  });

  it("keeps distinct editors' ranges independent through one shared highlight", () => {
    const source = createSource();
    const first = source.mountComment();
    const second = source.mountComment();
    expect(source.commentHighlight()?.size).toBe(2);

    first.cleanup();
    first.cleanup();

    expect(source.commentHighlight()?.size).toBe(1);
    expect(source.commentHighlight()?.has(second.range)).toBe(true);
    expect(second.onUnavailable).not.toHaveBeenCalled();
    second.cleanup();
    expect(source.commentHighlight()).toBeUndefined();
  });

  it("does not delete a replacement highlight when an older editor closes", () => {
    const source = createSource();
    const comment = source.mountComment();
    const original = source.commentHighlight();
    const replacement = new Set([new TestRange(source.text, () => rect(90))]);
    source.highlights.set("t3-assistant-citation-comment", replacement);

    comment.cleanup();

    expect(original?.size).toBe(0);
    expect(source.commentHighlight()).toBe(replacement);
    expect(replacement.size).toBe(1);
  });

  it("keeps native selection untouched when CSS highlights are unavailable", () => {
    const source = createSource();
    vi.stubGlobal("Highlight", undefined);
    const selection = new TestSelection();
    const selectedRange = new TestRange(source.text, () => rect(40));
    selection.addRange(selectedRange);
    const getSelection = vi.fn(() => selection);
    source.root.ownerDocument.getSelection = getSelection;
    const comment = source.mountComment();
    source.mutation(source.root);

    expect(source.commentHighlight()).toBeUndefined();
    expect(getSelection).not.toHaveBeenCalled();
    expect(selection.ranges).toEqual([selectedRange]);
    expect(comment.onUnavailable).not.toHaveBeenCalled();
    source.root.isConnected = false;
    source.mutation(source.scrollNode, [source.container]);
    expect(comment.onUnavailable).toHaveBeenCalledOnce();
    source.cleanup();
  });
});
