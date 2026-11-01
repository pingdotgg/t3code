import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import type { MarkdownLinkOccurrence } from "react-native-enriched-markdown";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Image: { resolveAssetSource: (source: { uri: string }) => source },
}));
vi.mock("../lib/markdownFileIcons.generated", () => ({
  MARKDOWN_FILE_ICON_SOURCES: new Proxy(
    {},
    { get: (_target, icon) => ({ uri: `icon:${String(icon)}` }) },
  ),
}));
vi.mock("../lib/contextChipIcons.generated", () => ({ CONTEXT_CHIP_ICON_SOURCES: {} }));
vi.mock("../lib/markdownLinkIcons.generated", () => ({ SOURCE_CONTROL_LINK_ICON_SOURCES: {} }));
vi.mock("../lib/useUniwindTheme", async () => {
  const { getMobileThemeVariables, DEFAULT_MOBILE_THEME_ID } = await import("../lib/mobileTheme");
  const theme = getMobileThemeVariables(DEFAULT_MOBILE_THEME_ID, "light");
  return { useUniwindTheme: () => theme };
});

import type { SelectableMarkdownTextProps } from "./SelectableMarkdownText.types";
import { useEnrichedLinkVariants } from "./useEnrichedLinkVariants";

const props: SelectableMarkdownTextProps = {
  markdown: "",
  textStyle: {
    color: "#111111",
    strongColor: "#111111",
    mutedColor: "#666666",
    linkColor: "#2255ff",
    inlineCodeColor: "#111111",
    codeColor: "#111111",
    codeBackgroundColor: "#eeeeee",
    codeBlockBackgroundColor: "#eeeeee",
    fileTextColor: "#111111",
    quoteMarkerColor: "#cccccc",
    dividerColor: "#cccccc",
    fontSize: 15,
    lineHeight: 22,
    fontFamily: "DMSans-Regular",
    headingFontFamily: "DMSans-Bold",
    boldFontFamily: "DMSans-Bold",
  },
};
const fileHrefs = new Set<string>();

async function pillContent(links: ReadonlyArray<MarkdownLinkOccurrence>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let result: ReturnType<typeof useEnrichedLinkVariants> | undefined;
  const urls = links.map((link) => link.url);
  function Probe() {
    const variants = useEnrichedLinkVariants(urls, props, fileHrefs, links);
    useLayoutEffect(() => {
      result = variants;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  act(() => root.unmount());
  return result!.linkPillContent;
}

it("shows the authored text of a file link written as prose", async () => {
  const content = await pillContent([
    { url: "docs/guide.md", label: "the setup steps", title: "" },
  ]);

  expect(content["docs/guide.md"]?.label).toBeUndefined();
  expect(content["docs/guide.md"]?.iconUri).toBeDefined();
});

it("keeps the file name chip for a file link labelled with its file name", async () => {
  const content = await pillContent([{ url: "docs/guide.md", label: "guide.md", title: "" }]);

  expect(content["docs/guide.md"]?.label).toBe("guide.md");
});

it("keeps the file name chip for an inline-code Windows path", async () => {
  // preserveWindowsPaths keeps the inline-code rewrite's escapes in the link text.
  const content = await pillContent([
    { url: "C:\\repo\\src\\a.ts", label: "C:\\\\repo\\\\src\\\\a.ts", title: "" },
  ]);

  expect(content["C:\\repo\\src\\a.ts"]?.label).toBe("a.ts");
});

it("keeps the file name chip for a file URL autolink", async () => {
  const url = "file:///home/me/docs/guide.md";
  const content = await pillContent([{ url, label: url, title: "" }]);

  expect(content[url]?.label).toBe("guide.md");
});
