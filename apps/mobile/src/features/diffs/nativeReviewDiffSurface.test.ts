import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, createElement, forwardRef, useImperativeHandle, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { NativeReviewDiffRow } from "./nativeReviewDiffSurface";
import type { computeVisibleNativeReviewWordDiffRanges } from "../review/nativeReviewWordDiffs";

type WordDiffInput = Parameters<typeof computeVisibleNativeReviewWordDiffRanges>[0];
type WordDiffResult = Awaited<ReturnType<typeof computeVisibleNativeReviewWordDiffRanges>>;

const wordJobs = vi.hoisted(
  () =>
    [] as Array<{
      readonly input: WordDiffInput;
      readonly complete: () => Promise<WordDiffResult>;
    }>,
);

const expoMocks = vi.hoisted(() => ({
  requireNativeView: vi.fn(),
}));
const nativeView = () => null;
const originalExpo = globalThis.expo;

function setExpoViewConfigAvailable() {
  globalThis.expo = {
    getViewConfig: vi.fn().mockReturnValue({ validAttributes: {}, directEventTypes: {} }),
  } as unknown as typeof globalThis.expo;
}

vi.mock("expo", () => ({
  requireNativeView: expoMocks.requireNativeView,
}));

vi.mock("./nativeReviewDiffHighlighter", () => ({
  highlightNativeReviewDiffVisibleRows: async () => ({ tokensByRowId: {}, rowCount: 0 }),
}));

vi.mock("../review/nativeReviewWordDiffs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../review/nativeReviewWordDiffs")>();
  return {
    ...actual,
    computeVisibleNativeReviewWordDiffRanges: (input: WordDiffInput) => {
      const deferred = Promise.withResolvers<WordDiffResult>();
      wordJobs.push({
        input,
        complete: async () => {
          const result = await actual.computeVisibleNativeReviewWordDiffRanges(input);
          deferred.resolve(result);
          return result;
        },
      });
      return deferred.promise;
    },
  };
});

describe("resolveNativeReviewDiffView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    wordJobs.length = 0;
    globalThis.expo = undefined as unknown as typeof globalThis.expo;
  });

  afterEach(() => {
    globalThis.expo = originalExpo;
    vi.unstubAllGlobals();
  });

  it("returns null when the native review diff view config is unavailable", async () => {
    const { resolveNativeReviewDiffView } = await import("./nativeReviewDiffSurface");
    expect(resolveNativeReviewDiffView()).toBeNull();
    expect(expoMocks.requireNativeView).not.toHaveBeenCalled();
  });

  it("returns the payload bridge when the native review diff view is installed", async () => {
    setExpoViewConfigAvailable();
    expoMocks.requireNativeView.mockReturnValue(nativeView);
    const { resolveNativeReviewDiffView } = await import("./nativeReviewDiffSurface");
    const resolvedView = resolveNativeReviewDiffView();
    expect(resolvedView).not.toBeNull();
    expect(resolvedView).not.toBe(nativeView);
    expect(resolveNativeReviewDiffView()).toBe(resolvedView);
    expect(expoMocks.requireNativeView).toHaveBeenCalledWith("T3ReviewDiffSurface");
  });

  it("returns null when the view manager cannot be required", async () => {
    setExpoViewConfigAvailable();
    const cause = new Error("boom");
    expoMocks.requireNativeView.mockImplementation(() => {
      throw cause;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { resolveNativeReviewDiffView } = await import("./nativeReviewDiffSurface");

    expect(resolveNativeReviewDiffView()).toBeNull();
    expect(resolveNativeReviewDiffView()).toBeNull();
    expect(expoMocks.requireNativeView).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "NativeViewResolutionError",
        nativeModuleName: "T3ReviewDiffSurface",
        cause,
      }),
    );
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("keeps visible word ranges across delayed delivery and highlight resets", async () => {
    setExpoViewConfigAvailable();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const frames = new Map<number, (time: number) => void>();
    let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const sent: string[] = [];
    const nativeHandle = {
      setRowsJson: async () => undefined,
      setTokensJson: async () => undefined,
      setTokensPatchJson: async (json: string) => {
        sent.push(json);
      },
    };
    const NativeMock = forwardRef<typeof nativeHandle>(function NativeMock(_props, ref) {
      useImperativeHandle(ref, () => nativeHandle, []);
      return null;
    });
    expoMocks.requireNativeView.mockReturnValue(NativeMock);
    const { resolveNativeReviewDiffView } = await import("./nativeReviewDiffSurface");
    const { useNativeReviewDiffHighlighting } =
      await import("../review/useNativeReviewDiffHighlighting");
    const NativeView = resolveNativeReviewDiffView();
    if (!NativeView) throw new Error("Expected the native payload sender");
    const pair = (id: string): NativeReviewDiffRow[] => [
      {
        kind: "line",
        id: `${id}:delete`,
        fileId: id,
        change: "delete",
        content: 'const item = renderPanel({ title: "before", active: true });',
      },
      {
        kind: "line",
        id: `${id}:add`,
        fileId: id,
        change: "add",
        content: 'const item = renderPanel({ title: "after", active: true });',
      },
    ];
    const rows: NativeReviewDiffRow[] = [
      ...pair("a"),
      ...Array.from({ length: 500 }, (_, index) => ({
        kind: "hunk" as const,
        id: `gap:${index}`,
        fileId: "gap",
      })),
      ...pair("b"),
    ];
    const input = {
      files: [],
      rows,
      scheme: "dark" as const,
      enabled: true,
      collapsedFileIds: [],
    };
    let changeRange:
      | ReturnType<typeof useNativeReviewDiffHighlighting>["updateVisibleRange"]
      | undefined;
    function Harness({
      resetKey = "source",
      contentResetKey = "view",
    }: {
      readonly resetKey?: string;
      readonly contentResetKey?: string;
    }) {
      const result = useNativeReviewDiffHighlighting({ ...input, resetKey, contentResetKey });
      useLayoutEffect(() => {
        changeRange = result.updateVisibleRange;
      }, [result.updateVisibleRange]);
      return createElement(NativeView!, {
        appearanceScheme: "dark",
        themeJson: "{}",
        rowHeight: 20,
        contentWidth: 1000,
        rowsJson: "[]",
        tokensResetKey: resetKey,
        contentResetKey,
        tokensPatchJson: result.tokensPatchJson,
        wordDiffRangesPatchJson: result.wordDiffRangesPatchJson,
        onWordDiffRangesPatchSent: result.onWordDiffRangesPatchSent,
      });
    }
    const flushFrames = () =>
      act(async () => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(performance.now());
        await Promise.resolve();
      });
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(createElement(Harness));
      });
      await flushFrames();
      await act(async () => {
        await wordJobs.at(-1)!.complete();
      });
      expect(sent.some((json) => json.includes('"a:delete"'))).toBe(false);
      await act(async () => {
        changeRange!({ firstRowIndex: 502, lastRowIndex: 503 });
      });
      await act(async () => {
        await wordJobs.at(-1)!.complete();
      });
      await flushFrames();
      expect(sent.some((json) => json.includes('"b:delete"'))).toBe(true);
      expect(sent.some((json) => json.includes('"a:delete"'))).toBe(false);
      await act(async () => {
        changeRange!({ firstRowIndex: 0, lastRowIndex: 1 });
      });
      expect(wordJobs.at(-1)!.input.alreadyHighlightedRowIds?.has("a:delete")).toBe(false);
      await act(async () => {
        await wordJobs.at(-1)!.complete();
      });
      await flushFrames();
      expect(sent.some((json) => json.includes('"a:delete"'))).toBe(true);
      await act(async () => {
        changeRange!({ firstRowIndex: 502, lastRowIndex: 503 });
      });
      await act(async () => {
        await wordJobs.at(-1)!.complete();
      });
      await act(async () => {
        renderer!.update(createElement(Harness, { resetKey: "refreshed" }));
      });
      expect(wordJobs.at(-1)!.input.firstRowIndex).toBe(502);
      await act(async () => {
        await wordJobs.at(-1)!.complete();
      });
      await flushFrames();
      expect(
        sent.some((json) => json.includes('"resetKey":"refreshed"') && json.includes('"b:delete"')),
      ).toBe(true);
      await act(async () => {
        renderer!.update(
          createElement(Harness, { resetKey: "new-source", contentResetKey: "new-view" }),
        );
      });
      expect(wordJobs.at(-1)!.input.firstRowIndex).toBe(0);
    } finally {
      await act(async () => renderer?.unmount());
    }
    expect(frames.size).toBe(0);
  });
});

describe("isPendingNativeViewRegistration", () => {
  it("recognizes registration races for the installed native view name", async () => {
    const { isPendingNativeViewRegistration } = await import("./nativeReviewDiffSurface");

    expect(
      isPendingNativeViewRegistration(
        new Error("Unable to find the 'T3ReviewDiffSurface' view for this native tag"),
      ),
    ).toBe(true);
    expect(
      isPendingNativeViewRegistration(
        new Error("Unable to find the 'T3ReviewDiffView' view for this native tag"),
      ),
    ).toBe(false);
    expect(
      isPendingNativeViewRegistration(
        new Error(
          "Unable to find the class expo.modules.t3reviewdiff.T3ReviewDiffView view with tag 1150",
        ),
      ),
    ).toBe(true);
  });
});

describe("isNativeReviewDiffDrawEvent", () => {
  it("accepts only native events emitted after diff rows draw", async () => {
    const { isNativeReviewDiffDrawEvent } = await import("./nativeReviewDiffSurface");

    expect(isNativeReviewDiffDrawEvent({ message: "draw-metrics" })).toBe(true);
    expect(isNativeReviewDiffDrawEvent({ message: "visible-range" })).toBe(true);
    expect(isNativeReviewDiffDrawEvent({ message: "rows-decoded" })).toBe(false);
  });
});
