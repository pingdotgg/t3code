import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

type RouteParams = { readonly path?: ReadonlyArray<string> };

const harness = vi.hoisted(() => ({
  navigate: [] as Array<[string, RouteParams | undefined]>,
  onLinkPress: undefined as ((href: string) => void) | undefined,
}));

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({
  View: ({ children }: Children) => <div>{children}</div>,
}));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: (props: {
    readonly data: ReadonlyArray<unknown>;
    readonly keyExtractor: (item: unknown, index: number) => string;
    readonly renderItem: (input: { item: unknown; index: number }) => ReactNode;
  }) => (
    <div>
      {props.data.map((item, index) => (
        <div key={props.keyExtractor(item, index)}>{props.renderItem({ item, index })}</div>
      ))}
    </div>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: {},
  useNavigation: () => ({
    navigate: (name: string, params?: RouteParams) => harness.navigate.push([name, params]),
  }),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({
  NativeScrollView: ({ children }: Children) => <div>{children}</div>,
}));
vi.mock("../../components/ui/RefreshControl", () => ({ RefreshControl: () => null }));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenWebLink: vi.fn() }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../threads/ThreadMarkdownImage", () => ({
  ThreadMarkdownImage: () => null,
  ThreadMarkdownImageView: () => null,
  ThreadMarkdownImageUnavailable: () => null,
}));
vi.mock("../threads/ThreadMarkdownVideo", () => ({ ThreadMarkdownVideo: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: () => null }));
vi.mock("../../components/ui/VideoPreviewModal", () => ({ VideoPreviewModal: () => null }));
vi.mock("../../components/ui/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../../native/useMarkdownImageSource", () => ({
  useMarkdownImageSource: () => () => null,
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    appearance: { baseFontSize: 15 },
    fontFamilies: { regular: "System", bold: "System-Bold" },
    monoFontFamily: "Menlo",
  }),
}));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: (props: { onLinkPress?: (href: string) => void }) => {
    harness.onLinkPress = props.onLinkPress;
    return null;
  },
}));
vi.mock("./SourceFileSurface", () => ({ SourceFileSurface: () => null }));

import { FileMarkdownPreview } from "./FileMarkdownPreview";

it("opens a home link from the home folder and a relative link from the Markdown folder", () => {
  harness.navigate.length = 0;
  renderToStaticMarkup(
    <FileMarkdownPreview
      cwd="/home/u/demo-repo"
      environmentId={"env-1" as EnvironmentId}
      markdown={"[Notes](~/notes.md) [Other](other.md)"}
      relativePath="docs/guide.md"
      threadId={"thread-1" as ThreadId}
    />,
  );

  harness.onLinkPress?.("~/notes.md");
  harness.onLinkPress?.("other.md");

  expect(harness.navigate.map(([name, params]) => [name, params?.path?.join("/")])).toEqual([
    ["ThreadFile", "/home/u/notes.md"],
    ["ThreadFile", "/home/u/demo-repo/docs/other.md"],
  ]);
});
