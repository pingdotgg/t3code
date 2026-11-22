import { act, type ComponentProps, type PropsWithChildren } from "react";
import { createRoot } from "react-dom/client";
import type { EnrichedMarkdownText } from "react-native-enriched-markdown";
import { expect, it, vi } from "vite-plus/test";

type WidgetProps = ComponentProps<typeof EnrichedMarkdownText>;

const widget = vi.hoisted(() => vi.fn<(_props: WidgetProps) => null>(() => null));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  StyleSheet: { hairlineWidth: 1 },
  useWindowDimensions: () => ({ fontScale: 1 }),
  View: ({ children }: PropsWithChildren) => children,
}));
vi.mock("react-native-enriched-markdown", () => ({ EnrichedMarkdownText: widget }));
vi.mock("../components/ui/Menu", () => ({ Menu: () => null }));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark", mathRenderingEnabled: false }),
}));
vi.mock("./HighlightedCodeBlock", () => ({ HighlightedCodeBlock: () => null }));
vi.mock("./MermaidCodeBlock", () => ({ MermaidCodeBlock: () => null }));
vi.mock("./useEnrichedLinkVariants", () => ({ useEnrichedLinkVariants: () => ({}) }));
vi.mock("../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));

import { MobileEnrichedMarkdownText } from "./EnrichedMarkdownText";

it("offers Open link only for destinations the host can open", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  widget.mockClear();
  const root = createRoot(document.createElement("div"));
  const webUrl = "https://example.com/";
  const fileUrl = "docs/readme.md";
  const markdown = `[Example](${webUrl}) [Docs](${fileUrl})`;
  const onLinkPress = vi.fn();
  const textStyle = {
    color: "#fff",
    strongColor: "#fff",
    mutedColor: "#aaa",
    linkColor: "#fff",
    inlineCodeColor: "#fff",
    codeColor: "#fff",
    codeBackgroundColor: "#000",
    codeBlockBackgroundColor: "#000",
    fileTextColor: "#fff",
    quoteMarkerColor: "#aaa",
    dividerColor: "#aaa",
    fontSize: 14,
    lineHeight: 20,
    fontFamily: "System",
    headingFontFamily: "System",
    boldFontFamily: "System",
  };

  try {
    await act(() =>
      root.render(
        <MobileEnrichedMarkdownText
          markdown={markdown}
          textStyle={textStyle}
          onLinkPress={onLinkPress}
          canOpenLinkFromMenu={(url: string) => url === webUrl}
        />,
      ),
    );
    await act(() =>
      widget.mock.lastCall?.[0].onLinksChange?.([
        { url: webUrl, label: "Example", title: "" },
        { url: fileUrl, label: "Docs", title: "" },
      ]),
    );

    const menus = Object.entries(widget.mock.lastCall?.[0].linkContextMenuItems ?? {});
    const menuFor = (url: string) => menus.find(([pattern]) => new RegExp(pattern).test(url))?.[1];

    expect(menuFor(fileUrl)?.map(({ text }) => text)).toEqual(["Copy link", "Share link"]);
    const webMenu = menuFor(webUrl);
    expect(webMenu?.map(({ text }) => text)).toEqual(["Open link", "Copy link", "Share link"]);
    webMenu?.find(({ text }) => text === "Open link")?.onPress({ url: webUrl });
    expect(onLinkPress).toHaveBeenCalledExactlyOnceWith(webUrl);
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
