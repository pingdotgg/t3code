import {
  act,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { HighlightNativeReviewDiffVisibleRowsInput } from "./nativeReviewDiffHighlighter";
import type { NativeReviewDiffViewProps } from "./nativeReviewDiffSurface";
import type { NativeReviewDiffData } from "../review/nativeReviewDiffAdapter";

const mocks = vi.hoisted(() => ({
  registrationFailures: 0,
  tokenAccepted: true as boolean | undefined,
  tokenCompletion: null as Promise<boolean> | null,
  onDebug: undefined as NativeReviewDiffViewProps["onDebug"],
  autoViewport: false,
  rows: vi.fn(),
  tokens: vi.fn(),
  highlight: vi.fn(),
}));

function RawView({
  ref: nativeRef,
  onDebug,
  initialFileId,
  contentResetKey,
}: NativeReviewDiffViewProps & { ref: Ref<unknown> }) {
  const [content, setContent] = useState({ resetKey: contentResetKey, rows: "" });
  const rows = content.resetKey === contentResetKey ? content.rows : "";
  const [tokenRowIds, setTokenRowIds] = useState<string[]>([]);
  useLayoutEffect(() => {
    mocks.onDebug = onDebug;
  });
  useImperativeHandle(nativeRef, () => ({
    async setRowsJson(value: string) {
      mocks.rows(value);
      if (mocks.registrationFailures > 0) {
        mocks.registrationFailures -= 1;
        throw new Error("Unable to find the 'T3ReviewDiffSurface' view for this native tag");
      }
      setContent({ resetKey: contentResetKey, rows: value });
      if (mocks.autoViewport) {
        const decoded = JSON.parse(value) as NativeReviewDiffData["rows"];
        onDebug?.({
          nativeEvent: { message: "rows-decoded", rows: decoded.length },
        } as unknown as Parameters<NonNullable<typeof onDebug>>[0]);
        const index = decoded.findIndex(
          (row) => row.kind === "file" && row.fileId === initialFileId,
        );
        onDebug?.({
          nativeEvent: {
            message: "visible-range",
            firstRowIndex: Math.max(0, index),
            lastRowIndex: Math.max(0, index) + 40,
            totalRows: decoded.length,
          },
        } as unknown as Parameters<NonNullable<typeof onDebug>>[0]);
      }
    },
    async scrollToFile() {},
    async setTokensPatchJson(value: string) {
      mocks.tokens(value);
      const accepted = mocks.tokenCompletion ? await mocks.tokenCompletion : mocks.tokenAccepted;
      if (accepted === true) {
        const patch = JSON.parse(value);
        setTokenRowIds((current) => [
          ...new Set([...current, ...Object.keys(patch.tokensByRowId)]),
        ]);
      }
      return accepted;
    },
  }));
  return (
    <div data-token-rows={tokenRowIds.join(",")}>
      {rows ? "Rendered diff" : "Blank native surface"}
    </div>
  );
}

vi.mock("expo", () => ({ requireNativeView: () => RawView }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: ({
    title,
    actionLabel,
    onAction,
  }: {
    title: string;
    actionLabel: string;
    onAction: () => void;
  }) => (
    <div>
      {title}
      <button onClick={onAction}>{actionLabel}</button>
    </div>
  ),
}));
vi.mock("./nativeReviewDiffHighlighter", () => ({
  highlightNativeReviewDiffVisibleRows: mocks.highlight,
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  settlePromise: async (execute: () => Promise<unknown>) => {
    try {
      return AsyncResult.success(await execute());
    } catch (error) {
      return AsyncResult.failure(Cause.die(error));
    }
  },
  squashAtomCommandFailure: () => "tokenization failed",
}));
vi.mock("../review/nativeReviewDiffAdapter", () => ({ createNativeReviewDiffTheme: () => ({}) }));
vi.mock("../settings/appearance/useAppearanceCodeSurface", () => ({
  useAppearanceCodeSurface: () => ({ nativeReviewDiffStyle: {} }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light", themeId: "test" }),
}));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));

import { resolveNativeReviewDiffView } from "./nativeReviewDiffSurface";
import { useNativeReviewDiffBridge } from "../review/useNativeReviewDiffBridge";
import {
  handlePullRequestDiffDebugEvent,
  pullRequestDiffInitialPosition,
} from "../pull-requests/pullRequestDiffDebug";

function setup(integrated = false) {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.registrationFailures = 0;
  mocks.tokenAccepted = true;
  mocks.tokenCompletion = null;
  mocks.onDebug = undefined;
  mocks.autoViewport = false;
  mocks.rows.mockClear();
  mocks.tokens.mockClear();
  mocks.highlight
    .mockReset()
    .mockImplementation(async (input: HighlightNativeReviewDiffVisibleRowsInput) => {
      const rowId = `r${input.firstRowIndex}`;
      const tokensByRowId = input.alreadyHighlightedRowIds?.has(rowId)
        ? {}
        : { [rowId]: [{ content: "const", color: "#ff0000", fontStyle: null }] };
      return {
        rowCount: Object.keys(tokensByRowId).length,
        durationMs: 0,
        retryableRowIds: [],
        tokensByRowId,
      };
    });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const requestFrame = vi
    .spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
  const cancelFrame = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    if (id != null) frames.delete(id);
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const expo = Object.getOwnPropertyDescriptor(globalThis, "expo");
  Object.defineProperty(globalThis, "expo", {
    configurable: true,
    value: { getViewConfig: () => ({}) },
  });
  const NativeDiff = resolveNativeReviewDiffView()!;
  const container = document.createElement("div");
  const root = createRoot(container);
  let data: NativeReviewDiffData = {
    rows: Array.from({ length: 1000 }, (_, index) =>
      index === 999
        ? { kind: "comment", id: `r${index}`, commentText: "Original comment" }
        : index === 900
          ? { kind: "file", id: `r${index}`, fileId: "last-file" }
          : { kind: "line", id: `r${index}` },
    ),
    files: [],
    additions: 0,
    deletions: 0,
    commentTargetsByRowId: new Map(),
    rowIdByCommentLineId: new Map(),
  };
  const ids: string[] = [];
  let collapsedFileIds: ReadonlyArray<string> = ids;
  function PullRequestDiff({ targetFileId }: { targetFileId?: string }) {
    const bridge = useNativeReviewDiffBridge({
      threadKey: null,
      sectionId: "pull-request:test:1:all",
      diff: "test diff",
      data,
      collapsedFileIds,
      viewedFileIds: ids,
      selectedRowIds: ids,
      canHighlight: true,
    });
    const nativeView = useRef(null);
    const jumpStarted = useRef(true);
    const onDebug: NonNullable<NativeReviewDiffViewProps["onDebug"]> = (event) =>
      handlePullRequestDiffDebugEvent(event, {
        rowCount: data.rows.length,
        targetFileId,
        focusIndex: -1,
        isIos: true,
        nativeView,
        jumpStarted: () => jumpStarted.current,
        setJumpStarted: (started) => {
          jumpStarted.current = started;
        },
        loadMore: () => {},
        onDebug: bridge.onDebug,
      });
    return (
      <NativeDiff
        {...bridge}
        {...pullRequestDiffInitialPosition(targetFileId, -1)}
        nativeViewRef={nativeView}
        appearanceScheme="light"
        rowHeight={20}
        contentWidth={300}
        onDebug={onDebug}
      />
    );
  }
  if (!integrated) {
    act(() =>
      root.render(
        <NativeDiff
          rowsJson="[]"
          tokensPatchJson='{"tokensByRowId":{}}'
          appearanceScheme="light"
          themeJson="{}"
          rowHeight={20}
          contentWidth={300}
        />,
      ),
    );
  }
  return {
    container,
    async mountPullRequest(targetFileId?: string) {
      await act(async () => root.render(<PullRequestDiff targetFileId={targetFileId} />));
    },
    async collapseFiles(fileIds: ReadonlyArray<string>) {
      collapsedFileIds = fileIds;
      await act(async () => root.render(<PullRequestDiff />));
    },
    async updateComment() {
      data = {
        ...data,
        rows: data.rows.map((row) =>
          row.kind === "comment" ? { ...row, commentText: "Updated comment" } : row,
        ),
      };
      await act(async () => root.render(<PullRequestDiff />));
    },
    get tokenRows() {
      return container.querySelector("[data-token-rows]")?.getAttribute("data-token-rows");
    },
    async jump(firstRowIndex: number, totalRows = 1000) {
      await act(async () => {
        mocks.onDebug?.({
          nativeEvent: {
            message: "visible-range",
            firstRowIndex,
            lastRowIndex: firstRowIndex + 40,
            totalRows,
          },
        } as unknown as Parameters<NonNullable<NativeReviewDiffViewProps["onDebug"]>>[0]);
        await vi.runOnlyPendingTimersAsync();
      });
    },
    async deliverPayloads() {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(async () => {
        for (const callback of callbacks) callback(0);
        await vi.runOnlyPendingTimersAsync();
      });
    },
    retry() {
      const button = container.querySelector("button");
      expect(button?.textContent).toBe("Retry diff");
      act(() => button!.click());
    },
    decodeFailure() {
      act(() =>
        mocks.onDebug?.({
          nativeEvent: { message: "rows-decode-failed", error: "Decode failed" },
        } as unknown as Parameters<NonNullable<NativeReviewDiffViewProps["onDebug"]>>[0]),
      );
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      errors.mockRestore();
      vi.useRealTimers();
      if (expo) Object.defineProperty(globalThis, "expo", expo);
      else Reflect.deleteProperty(globalThis, "expo");
    },
  };
}

it("retries transient native registration without replacing the diff with an error", async () => {
  using screen = setup();
  mocks.registrationFailures = 1;
  await screen.deliverPayloads();
  expect(screen.container.textContent).toBe("Blank native surface");
  await screen.deliverPayloads();
  expect(screen.container.textContent).toBe("Rendered diff");
});

it.each([false, undefined])(
  "keeps colors queued until native accepts them and recovers rejected patches (%s)",
  async (rejected) => {
    using screen = setup(true);
    await screen.mountPullRequest();
    let accept!: (accepted: boolean) => void;
    mocks.tokenCompletion = new Promise((resolve) => {
      accept = resolve;
    });
    mocks.tokens.mockClear();
    await screen.jump(0);
    await screen.deliverPayloads();
    await screen.jump(400);
    await screen.deliverPayloads();
    expect(
      mocks.tokens.mock.calls.map(([json]) => Object.keys(JSON.parse(json).tokensByRowId)),
    ).toEqual([["r0"]]);
    await act(async () => accept(true));

    mocks.tokenCompletion = null;
    mocks.tokenAccepted = rejected;
    await screen.deliverPayloads();
    expect(screen.tokenRows).toBe("r0");

    mocks.tokenAccepted = true;
    await screen.jump(800);
    await screen.deliverPayloads();
    expect(screen.tokenRows).toBe("r0,r800");
    await screen.jump(400);
    await screen.deliverPayloads();
    expect(screen.tokenRows).toBe("r0,r800,r400");
  },
);

it.each(["retry", "comment update"])(
  "re-highlights accepted rows after a native row failure, PR %s, and viewport revisit",
  async (recovery) => {
    using screen = setup(true);
    await screen.mountPullRequest();
    mocks.tokens.mockClear();
    await screen.jump(0);
    await screen.deliverPayloads();
    await screen.jump(400);
    await screen.deliverPayloads();
    expect(screen.tokenRows).toBe("r0,r400");

    screen.decodeFailure();
    expect(screen.container.textContent).toContain("Could not display diff");
    if (recovery === "retry") await act(async () => screen.retry());
    else await screen.updateComment();
    await screen.deliverPayloads();
    expect(screen.container.textContent).toBe("Rendered diff");
    await screen.jump(800);
    await screen.deliverPayloads();
    await screen.jump(400);
    await screen.deliverPayloads();
    expect(screen.tokenRows?.split(",")).toContain("r400");
  },
);

it("delivers the selected file first with a warm highlighter and no startup command", async () => {
  using screen = setup(true);
  mocks.autoViewport = true;
  await screen.mountPullRequest("last-file");
  await screen.deliverPayloads();
  await screen.deliverPayloads();
  expect(screen.tokenRows).toBe("r900");
});

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

it("cancels stale collapse work and highlights expansion without resetting accepted tokens", async () => {
  using screen = setup(true);
  await screen.mountPullRequest();
  await screen.jump(0);
  await screen.deliverPayloads();
  expect(screen.tokenRows).toBe("r0");

  const response = Promise.withResolvers<void>();
  const highlight = mocks.highlight.getMockImplementation()!;
  mocks.highlight.mockImplementation(async (input: HighlightNativeReviewDiffVisibleRowsInput) => {
    if (input.firstRowIndex === 400) {
      await response.promise;
      if (input.collapsedFileIds?.has("last-file")) {
        return { tokensByRowId: {}, rowCount: 0, retryableRowIds: [], durationMs: 0 };
      }
    }
    return highlight(input);
  });
  await screen.jump(400);
  await screen.collapseFiles(["last-file"]);
  await act(async () => response.resolve());
  await screen.deliverPayloads();
  expect(screen.tokenRows).toBe("r0");

  await screen.collapseFiles([]);
  await screen.deliverPayloads();
  expect(screen.tokenRows).toBe("r0,r400");
  await screen.jump(0);
  await screen.deliverPayloads();
  expect(screen.tokenRows).toBe("r0,r400");
});
