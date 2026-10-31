import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { NativeReviewDiffViewProps } from "../diffs/nativeReviewDiffSurface";
import type { HighlightScheme } from "../../lib/highlights";

const mocks = vi.hoisted(() => ({
  theme: "dark" as HighlightScheme,
  wordBreak: false,
  native: false,
  tokenize: vi.fn<(source: string, language: number) => ArrayBuffer | null>(),
  wasmTokenize: undefined as ((source: string, language: number) => ArrayBuffer) | undefined,
}));

function Host({ children }: { children?: ReactNode }) {
  return <div>{children}</div>;
}

function NativeSource(props: NativeReviewDiffViewProps) {
  return <div data-native-source data-rows={props.rowsJson} data-tokens={props.tokensJson} />;
}

vi.mock("expo", async () => {
  const { createWasmHighlightsModule } = await import("../../lib/highlights.testing");
  mocks.wasmTokenize = createWasmHighlightsModule().tokenize;
  return { requireOptionalNativeModule: () => ({ tokenize: mocks.tokenize }) };
});
vi.mock("react-native", () => ({
  View: Host,
  ScrollView: Host,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  RefreshControl: () => null,
  FlatList: ({
    data,
    renderItem,
    keyExtractor,
  }: {
    data: string[];
    keyExtractor: (item: string, index: number) => string;
    renderItem: (input: { item: string; index: number }) => ReactNode;
  }) => (
    <div data-line-list>
      {data.map((item, index) => (
        <div key={keyExtractor(item, index)}>{renderItem({ item, index })}</div>
      ))}
    </div>
  ),
  Platform: { OS: "ios", select: (options: { ios: string }) => options.ios },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock("@t3tools/mobile-source-text", () => ({
  SourceText: ({
    children,
    selectable,
    style,
  }: {
    children?: ReactNode;
    selectable?: boolean;
    style?: ComponentProps<"span">["style"];
  }) => (
    <span data-source-text data-selectable={selectable} style={style}>
      {children}
    </span>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../native/native-layout-metrics", () => ({ useNativeColumnLayoutMetrics: () => null }));
vi.mock("../diffs/nativeReviewDiffSurface", () => ({
  resolveNativeReviewDiffView: () => (mocks.native ? NativeSource : null),
}));
vi.mock("../review/nativeReviewDiffAdapter", () => ({ createNativeReviewDiffTheme: () => ({}) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Host }));
vi.mock("../../components/ui/LoadingStrip", () => ({
  LoadingStrip: () => <div data-loading>Highlighting</div>,
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: mocks.theme, themeId: "test" }),
}));
vi.mock("../settings/appearance/useAppearanceCodeSurface", () => ({
  useAppearanceCodeSurface: () => ({
    codeWordBreak: mocks.wordBreak,
    codeSurface: { fontSize: 14, rowHeight: 20, gutterWidth: 40, lineNumberFontSize: 12 },
    nativeSourceStyle: {},
  }),
}));
vi.mock("../../lib/useUniwindTheme", () => ({
  useUniwindTheme: () => ({ "--color-foreground": "#123456" }),
}));

import { SourceFileSurface } from "./SourceFileSurface";
import * as sourceHighlighting from "./sourceHighlightingState";
import { highlightCode } from "../../lib/highlights";
import { prepareSourceFileDocument } from "./source-file-document";

type Props = ComponentProps<typeof SourceFileSurface>;

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.theme = "dark";
  mocks.wordBreak = false;
  mocks.native = false;
  mocks.tokenize.mockReset().mockImplementation(mocks.wasmTokenize!);
  const acquisition = vi.spyOn(sourceHighlighting, "sourceHighlightAtom");
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  const root = createRoot(container);
  return {
    acquisition,
    registry,
    container,
    render(props: Props) {
      act(() =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <SourceFileSurface {...props} />
          </RegistryContext.Provider>,
        ),
      );
    },
    expectReady() {
      expect(container.querySelector("[data-loading]")).toBeNull();
      expect(
        [...container.querySelectorAll("div")].some(
          (element) => element.childNodes.length === 1 && element.textContent === "Plain text",
        ),
      ).toBe(false);
    },
    expectSelectableText(contents: string, plain = false) {
      const block = container.querySelector('[data-source-text][data-selectable="true"]');
      expect(block).not.toBeNull();
      expect(block!.textContent).toBe(contents);
      // The host stand-in checks the complete selection/copy representation, not native clipboard UI.
      const range = document.createRange();
      range.selectNodeContents(block!);
      expect(range.toString()).toBe(contents);
      if (plain) expect(block!.childNodes.length).toBe(contents ? 1 : 0);
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
      acquisition.mockRestore();
    },
  };
}

function source(lineCount: number) {
  return Array.from({ length: lineCount }, (_, i) => `const café${i} = "🎉 é";`).join("\n");
}

it.each([2_001, 10_000])(
  "skips cold selectable acquisition for %i normalized lines and stays ready",
  (count) => {
    using screen = setup();
    mocks.native = true;
    const contents = source(count - 1) + "\r\n";
    screen.render({ path: `cold-${count}.ts`, contents, selectable: true });
    screen.expectSelectableText(prepareSourceFileDocument(contents).contents, true);
    screen.expectReady();
    expect(screen.container.querySelector("[data-native-source]")).toBeNull();
    expect.soft(screen.acquisition).toHaveBeenCalledTimes(0);
    expect.soft(mocks.tokenize).toHaveBeenCalledTimes(0);
  },
);

it.each(["\n", "\r\n", "\r"])(
  "skips a blank selectable document above the budget after normalizing %j",
  (newline) => {
    using screen = setup();
    const contents = newline.repeat(2_000);
    screen.render({ path: "blank-large.ts", contents, selectable: true });
    screen.expectSelectableText("\n".repeat(2_000), true);
    screen.expectReady();
    expect.soft(screen.acquisition).toHaveBeenCalledTimes(0);
    expect.soft(mocks.tokenize).toHaveBeenCalledTimes(0);
  },
);

it("keeps hook order and readiness across content, appearance and selectable changes", () => {
  using screen = setup();
  const large = source(2_001);
  const path = "transitions.ts";
  screen.render({ path, contents: large, selectable: true });
  mocks.theme = "light";
  screen.render({ path, contents: large, selectable: true });
  const replacement = large + "\r\n// replaced";
  screen.render({ path, contents: replacement, selectable: true });
  screen.expectSelectableText(prepareSourceFileDocument(replacement).contents, true);
  screen.expectReady();
  expect(screen.acquisition).toHaveBeenCalledTimes(0);
  expect(mocks.tokenize).toHaveBeenCalledTimes(0);

  const short = 'const café = "🎉";\n';
  screen.render({ path, contents: short, selectable: true });
  screen.expectSelectableText(short);
  screen.expectReady();
  expect(mocks.tokenize).toHaveBeenCalledTimes(1);
  expect(screen.acquisition).toHaveBeenCalledTimes(1);
  mocks.theme = "dark";
  screen.render({ path, contents: short, selectable: true });
  screen.expectSelectableText(short);
  screen.expectReady();
  expect(mocks.tokenize).toHaveBeenCalledTimes(2);
  const expected = highlightCode(short, "typescript", "dark")[0]!;
  const spans = [
    ...screen.container.querySelectorAll<HTMLElement>('[data-source-text][style*="font-weight"]'),
  ];
  expect(spans.map((span) => span.textContent)).toEqual(expected.map((token) => token.content));
  expect(spans.map((span) => span.style.color)).toEqual(
    expected.map((token) => {
      const element = document.createElement("span");
      element.style.color = token.color ?? "#123456";
      return element.style.color;
    }),
  );
  mocks.tokenize.mockClear();
  screen.acquisition.mockClear();

  screen.render({ path, contents: large, selectable: false });
  expect(mocks.tokenize).toHaveBeenCalledTimes(1);
  expect(screen.acquisition).toHaveBeenCalledTimes(1);
  expect(screen.container.querySelectorAll("[data-line-list] > div")).toHaveLength(2_001);
  screen.expectReady();
  screen.render({ path, contents: large, selectable: true });
  screen.expectSelectableText(large, true);
  screen.expectReady();
  expect(mocks.tokenize).toHaveBeenCalledTimes(1);
  expect(screen.acquisition).toHaveBeenCalledTimes(1);
});

it.each([1_999, 2_000])(
  "still acquires highlighting for exactly %i blank selectable lines",
  (count) => {
    using screen = setup();
    const contents = "\n".repeat(count - 1);
    screen.render({ path: `boundary-${count}.ts`, contents, selectable: true });
    screen.expectSelectableText(contents);
    screen.expectReady();
    expect(screen.acquisition).toHaveBeenCalledTimes(1);
    expect(mocks.tokenize).toHaveBeenCalledTimes(1);
    // Blank lines use only the outer line spans, so 2,000 lines remain renderable.
    expect(screen.container.querySelector('[data-selectable="true"]')!.childNodes).toHaveLength(
      count,
    );
  },
);

it.each([false, true])(
  "retains large nonselectable highlighting on the native=%s path",
  (native) => {
    using screen = setup();
    mocks.native = native;
    const contents = source(2_001);
    screen.render({ path: `nonselectable-${native}.ts`, contents });
    screen.expectReady();
    expect(screen.acquisition).toHaveBeenCalledTimes(1);
    expect(mocks.tokenize).toHaveBeenCalledTimes(1);
    if (native) {
      const view = screen.container.querySelector("[data-native-source]")!;
      const rows = JSON.parse(view.getAttribute("data-rows")!);
      const tokens = JSON.parse(view.getAttribute("data-tokens")!);
      expect(rows).toHaveLength(2_001);
      expect(rows[2_000].content).toBe(contents.split("\n")[2_000]);
      expect(Object.keys(tokens)).toHaveLength(2_001);
      expect(
        tokens["source-line:2000"].map((token: { content: string }) => token.content).join(""),
      ).toBe(rows[2_000].content);
    } else expect(screen.container.querySelectorAll("[data-line-list] > div")).toHaveLength(2_001);
  },
);

it("preserves error presentation and recovers to intentional ready plain text", () => {
  using screen = setup();
  mocks.tokenize.mockImplementation(() => {
    throw new Error("tokenizer failed");
  });
  screen.render({ path: "error.ts", contents: "const broken = 1;", selectable: true });
  expect(screen.container.textContent).toContain("Plain text");
  screen.expectSelectableText("const broken = 1;", true);
  expect(mocks.tokenize).toHaveBeenCalledTimes(1);
  screen.render({ path: "error.ts", contents: source(2_001), selectable: true });
  screen.expectReady();
  screen.expectSelectableText(source(2_001), true);
  expect(mocks.tokenize).toHaveBeenCalledTimes(1);
  expect(screen.acquisition).toHaveBeenCalledTimes(1);
});

it("does not suppress a useful reader of the same large highlight atom", () => {
  using screen = setup();
  const contents = source(2_001);
  const input = { path: "shared-reader.ts", contents, theme: "dark" as const };
  const atom = sourceHighlighting.sourceHighlightAtom(input);
  const release = screen.registry.mount(atom);
  try {
    expect(mocks.tokenize).toHaveBeenCalledTimes(1);
    screen.acquisition.mockClear();
    screen.render({ ...input, selectable: true });
    screen.expectReady();
    screen.expectSelectableText(contents, true);
    expect(screen.acquisition).toHaveBeenCalledTimes(0);
    expect(mocks.tokenize).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
});

it.each(["", "\r", "\r\n\r\né 🎉\r", "x".repeat(4_000)])(
  "preserves small selectable text and ready status (%j)",
  (contents) => {
    using screen = setup();
    screen.render({ path: "small.ts", contents, selectable: true });
    screen.expectSelectableText(prepareSourceFileDocument(contents).contents);
    screen.expectReady();
    expect(screen.acquisition).toHaveBeenCalledTimes(1);
    expect(mocks.tokenize).toHaveBeenCalledTimes(1);
  },
);
