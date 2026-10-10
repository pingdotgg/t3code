import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { NativeMarkdownTextRun } from "./nativeMarkdownText";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

const { selectionRegions, platform } = vi.hoisted(() => ({
  selectionRegions: [] as ReadonlyArray<NativeMarkdownTextRun>[],
  platform: { OS: "ios", select: (options: { ios: string }) => options.ios },
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <>{children}</>,
  Text: ({ children }: { children: ReactNode }) => <>{children}</>,
  ScrollView: ({ children }: { children: ReactNode }) => <>{children}</>,
  Image: () => null,
  Platform: platform,
  useColorScheme: () => "light",
}));
vi.mock("./CopyTextButton", () => ({ CopyTextButton: () => null }));
vi.mock("./MarkdownTextPrimitive", () => ({
  MarkdownTextPrimitive: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
// Record the text owned by each native selection region. Grouping and run
// generation still execute in the real renderer, before the native boundary.
vi.mock("./NativeMarkdownSelectableText", () => ({
  NativeMarkdownSelectableText: ({ runs }: { runs: ReadonlyArray<NativeMarkdownTextRun> }) => {
    selectionRegions.push(runs);
    return null;
  },
}));

import { NativeMarkdownBlock } from "./NativeMarkdownBlock";

const textStyle: NativeMarkdownTextStyle = {
  color: "#111111",
  strongColor: "#111111",
  mutedColor: "#777777",
  linkColor: "#0000ff",
  inlineCodeColor: "#111111",
  codeColor: "#111111",
  codeBackgroundColor: "#eeeeee",
  codeBlockBackgroundColor: "#eeeeee",
  fileTextColor: "#111111",
  skillTextColor: "#111111",
  quoteMarkerColor: "#777777",
  dividerColor: "#777777",
  fontSize: 15,
  lineHeight: 22,
  fontFamily: "system",
  headingFontFamily: "system",
  boldFontFamily: "system",
};

function paragraph(content: string): MarkdownNode {
  return { type: "paragraph", children: [{ type: "text", content }] };
}

function renderBlock(node: MarkdownNode) {
  renderToString(
    <NativeMarkdownBlock
      node={node}
      skills={[]}
      textStyle={textStyle}
      highlightCode={async () => []}
    />,
  );
  return selectionRegions.map((runs) => runs.map((run) => run.text).join(""));
}

describe("blockquote selection regions", () => {
  beforeEach(() => {
    selectionRegions.length = 0;
    platform.OS = "ios";
  });

  it("keeps a multi-paragraph email in one native selection region", () => {
    expect(
      renderBlock({
        type: "blockquote",
        children: [paragraph("Hello,"), paragraph("The draft is ready."), paragraph("Thank you.")],
      }),
    ).toEqual(["Hello,\n\nThe draft is ready.\n\nThank you."]);
  });

  it("groups prose on each side of code and nested quotes without flattening them", () => {
    expect(
      renderBlock({
        type: "blockquote",
        children: [
          paragraph("Before one."),
          paragraph("Before two."),
          { type: "code_block", children: [{ type: "text", content: "const answer = 42;" }] },
          paragraph("After one."),
          paragraph("After two."),
          { type: "blockquote", children: [paragraph("Nested one."), paragraph("Nested two.")] },
          paragraph("Tail."),
        ],
      }),
    ).toEqual([
      "Before one.\n\nBefore two.",
      "After one.\n\nAfter two.",
      "Nested one.\n\nNested two.",
      "Tail.",
    ]);
  });

  it("aligns a quoted list with its content inside an outer list item", () => {
    const regions = renderBlock({
      type: "list",
      children: [
        {
          type: "list_item",
          children: [
            {
              type: "blockquote",
              children: [
                paragraph("Tasks"),
                {
                  type: "list",
                  children: [{ type: "list_item", children: [paragraph("Nested task")] }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(selectionRegions[0]?.find((run) => run.role === "list-marker")).toMatchObject({
      firstLineHeadIndent: 0,
      headIndent: 24,
    });
    expect(regions).toEqual(["Tasks\n\n•\tNested task"]);
  });

  it("keeps quoted lists on Android's dedicated list renderer", () => {
    platform.OS = "android";
    expect(
      renderBlock({
        type: "blockquote",
        children: [
          {
            type: "list",
            children: [
              {
                type: "list_item",
                children: [
                  paragraph("Outer item"),
                  {
                    type: "list",
                    children: [{ type: "list_item", children: [paragraph("Nested item")] }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toEqual(["Outer item", "Nested item"]);
  });
});
