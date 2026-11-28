import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  openedLinks: [] as string[],
  openWindow: null as ((event: { nativeEvent: { targetUrl: string } }) => void) | null,
  message: null as ((event: { nativeEvent: { data: string } }) => void) | null,
  injectedJavaScript: "",
  preview: null as unknown,
}));

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: Children) => <div>{children}</div>,
  Pressable: ({ children }: Children) => <div>{children}</div>,
}));
vi.mock("react-native-webview", () => ({
  WebView: (props: {
    onOpenWindow: typeof harness.openWindow;
    onMessage: typeof harness.message;
    injectedJavaScript: string;
  }) => {
    harness.openWindow = props.onOpenWindow;
    harness.message = props.onMessage;
    harness.injectedJavaScript = props.injectedJavaScript;
    return null;
  },
}));
vi.mock("../../components/ui/FilePreviewModal", () => ({
  FilePreviewModal: (props: { source: unknown }) => {
    harness.preview = props.source;
    return null;
  },
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));
vi.mock("../../lib/htmlRenderTheme", () => ({
  mobileHtmlRenderTheme: () => ({ variables: {} }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({}),
}));
vi.mock("../../state/assets", () => ({
  useAssetUrlState: () => ({ _tag: "Initial" }),
  useRefreshAssetUrl: () => async () => null,
}));
vi.mock("../../native/useOpenPullRequest", () => ({
  useOpenPullRequest: () => async (url: string) => {
    harness.openedLinks.push(url);
    return true;
  },
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));

import { HtmlRenderWebView } from "./HtmlRenderWebView";

it("opens a render's issue link the way the thread's own links open", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(<HtmlRenderWebView uri="https://assets.test/render.html" title="Links" nested />),
  );

  const issueUrl = "https://github.com/pingdotgg/t3code/issues/41939";
  await act(async () => harness.openWindow?.({ nativeEvent: { targetUrl: issueUrl } }));

  expect(harness.openedLinks).toEqual([issueUrl]);
  await act(async () => root.unmount());
});

it("opens a tapped render image in the image viewer with the page's other images", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <HtmlRenderWebView uri="https://assets.test/render.html" title="Gallery" nested={false} />,
    ),
  );

  expect(harness.injectedJavaScript).toContain("t3/notifications/open-image");
  const images = [
    { src: "data:image/png;base64,AAAA", name: "settings.png" },
    { src: "https://assets.test/profile.png", name: "profile.png" },
  ];
  await act(async () =>
    harness.message?.({
      nativeEvent: {
        data: JSON.stringify({
          jsonrpc: "2.0",
          method: "t3/notifications/open-image",
          params: { src: images[1]!.src, name: images[1]!.name, images, index: 1 },
        }),
      },
    }),
  );

  const gallery = images.map((image) => ({ kind: "image", uri: image.src, name: image.name }));
  expect(harness.preview).toEqual({ ...gallery[1], gallery });
  await act(async () => root.unmount());
});
