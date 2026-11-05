import { AsyncResult } from "effect/reactivity";
import { act, useImperativeHandle, useRef, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => {
  const Slot = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Slot,
    Text: Slot,
    ScrollView: Slot,
    RefreshControl: () => null,
    Platform: { OS: "android", select: (options: { android: string }) => options.android },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
    FlatList: (props: {
      readonly ref: Ref<unknown>;
      readonly data: string[];
      readonly renderItem: (item: { item: string; index: number }) => ReactNode;
    }) => {
      const element = useRef<HTMLDivElement>(null);
      useImperativeHandle(props.ref, () => ({
        props: { data: props.data },
        scrollToIndex: ({ index }: { index: number }) => {
          element.current!.scrollTop = index * 24;
        },
      }));
      return (
        <div ref={element} data-testid="source-lines">
          {props.data.map((item, index) => (
            <div key={item}>{props.renderItem({ item, index })}</div>
          ))}
        </div>
      );
    },
  };
});
vi.mock("@t3tools/mobile-source-text", () => ({
  SourceText: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("react-native-webview", () => ({
  WebView: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("../../native/native-layout-metrics", () => ({ useNativeColumnLayoutMetrics: () => null }));
vi.mock("../diffs/nativeReviewDiffSurface", () => ({ resolveNativeReviewDiffView: () => null }));
vi.mock("../review/nativeReviewDiffAdapter", () => ({ createNativeReviewDiffTheme: () => ({}) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: () => null }));
vi.mock("../../components/ui/LoadingStrip", () => ({ LoadingStrip: () => null }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("../settings/appearance/useAppearanceCodeSurface", () => ({
  useAppearanceCodeSurface: () => ({
    codeWordBreak: true,
    codeSurface: { rowHeight: 24, fontSize: 14, lineNumberFontSize: 12, gutterWidth: 40 },
  }),
}));
vi.mock("../../lib/useUniwindTheme", () => ({
  useUniwindTheme: () => ({ "--color-foreground": "#000000" }),
}));
vi.mock("./sourceHighlightingState", () => ({ sourceHighlightAtom: () => null }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => AsyncResult.success(null) }));

import { SourceFileSurface } from "./SourceFileSurface";

function setup() {
  const contents = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 16));
  vi.stubGlobal("cancelAnimationFrame", (frame: ReturnType<typeof setTimeout>) =>
    clearTimeout(frame),
  );
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  return {
    render(selectable: boolean) {
      act(() =>
        root.render(
          <SourceFileSurface
            contents={contents}
            path="fixture.txt"
            initialLine={40}
            selectable={selectable}
          />,
        ),
      );
      act(() => vi.runAllTimers());
    },
    lineList: () => container.querySelector<HTMLDivElement>('[data-testid="source-lines"]'),
    [Symbol.dispose]() {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    },
  };
}

it("restores the requested wrapped line after leaving selection mode", () => {
  using screen = setup();
  screen.render(false);
  const firstList = screen.lineList()!;
  expect(firstList.scrollTop).toBe(39 * 24);

  screen.render(true);
  expect(screen.lineList()).toBeNull();

  screen.render(false);
  const returnedList = screen.lineList()!;
  expect(returnedList).not.toBe(firstList);
  expect(returnedList.scrollTop).toBe(39 * 24);
});
