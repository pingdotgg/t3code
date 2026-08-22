import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  resources: [] as Array<unknown>,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <Value,>(value: Value) => value,
  useMemo: <Value,>(factory: () => Value) => factory(),
  useState: <Value,>(initial: Value | (() => Value)) => [
    typeof initial === "function" ? (initial as () => Value)() : initial,
    vi.fn(),
  ],
}));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Image: "Image",
  RefreshControl: "RefreshControl",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
}));
vi.mock("react-native-gesture-handler", () => ({ TouchableOpacity: "TouchableOpacity" }));
vi.mock("react-native-nitro-markdown", () => ({
  Markdown: (props: {
    readonly children: string;
    readonly renderers: {
      readonly image: (input: {
        readonly node: { readonly href: string; readonly alt: string; readonly title: null };
      }) => ReactNode;
    };
  }) => {
    const match = /!\[([^\]]*)]\(([^)]+)\)/.exec(props.children);
    return match?.[2]
      ? props.renderers.image({
          node: { href: match[2], alt: match[1] ?? "", title: null },
        })
      : null;
  },
}));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: vi.fn() }));
vi.mock("../../lib/useFontFamily", () => ({ useFontFamily: () => "System" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#000" }));
vi.mock("../../native/SelectableMarkdownText", () => ({
  hasNativeSelectableMarkdownText: () => false,
  SelectableMarkdownText: () => null,
}));
vi.mock("../../state/assets", () => ({
  useAssetUrlState: (_environmentId: unknown, resource: unknown) => {
    testState.resources.push(resource);
    return { _tag: "Success", url: "https://signed.test/diagram.png" };
  },
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ appearance: { baseFontSize: 14 } }),
}));

import { FileMarkdownPreview } from "./FileMarkdownPreview";

function renderTree(node: ReactNode): void {
  if (Array.isArray(node)) {
    node.forEach(renderTree);
    return;
  }
  if (!isValidElement(node)) return;
  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === "function") {
    const render = element.type as (props: Record<string, unknown>) => ReactNode;
    renderTree(render(element.props));
    return;
  }
  renderTree(element.props.children as ReactNode);
}

describe("FileMarkdownPreview workspace images", () => {
  beforeEach(() => {
    testState.resources = [];
  });

  it.each([
    ["/workspace/project", "docs/README.md", "/workspace/project/docs/images/diagram.png"],
    [
      "C:\\Users\\shawn\\project",
      "docs\\README.md",
      "C:\\Users\\shawn\\project\\docs\\images\\diagram.png",
    ],
  ])(
    "requests a nested file image beside the document in %s",
    (cwd, relativePath, expectedPath) => {
      renderTree(
        FileMarkdownPreview({
          cwd,
          relativePath,
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
          markdown: "![diagram](images/diagram.png)",
        }),
      );

      expect(testState.resources).toEqual([
        {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: expectedPath,
        },
      ]);
    },
  );
});
