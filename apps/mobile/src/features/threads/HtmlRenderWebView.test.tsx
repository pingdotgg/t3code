import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  openedLinks: [] as string[],
  openWindow: null as ((event: { nativeEvent: { targetUrl: string } }) => void) | null,
  asset: { _tag: "Initial" } as { _tag: string; url?: string },
}));

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: Children) => <div>{children}</div>,
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
  }: Children & { accessibilityLabel?: string; onPress?: () => void }) => (
    <div role="button" aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </div>
  ),
}));
vi.mock("react-native-webview", () => ({
  WebView: (props: { onOpenWindow: typeof harness.openWindow }) => {
    harness.openWindow = props.onOpenWindow;
    return <iframe title="webview" />;
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
  useAssetUrlState: () => harness.asset,
  useRefreshAssetUrl: () => async () => null,
}));
vi.mock("../../native/useOpenPullRequest", () => ({
  useOpenPullRequest: () => async (url: string) => {
    harness.openedLinks.push(url);
    return true;
  },
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));

import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { HtmlRenderWebView, ThreadHtmlRender } from "./HtmlRenderWebView";

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

it("unmounts a stopped render's page and runs it again on request", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.asset = { _tag: "Success", url: "https://assets.test/spin.html" };
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <ThreadHtmlRender
        environmentId={EnvironmentId.make("environment")}
        threadId={ThreadId.make("thread")}
        render={{ attachmentId: "spin", title: "Spin", height: 200 }}
        frameWidth={360}
        iconColor="black"
      />,
    ),
  );
  const button = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`);

  expect(container.querySelector("iframe")).not.toBeNull();
  await act(async () => button("Stop Spin")?.click());
  expect(container.querySelector("iframe")).toBeNull();

  await act(async () => button("Run Spin again")?.click());
  expect(container.querySelector("iframe")).not.toBeNull();
  await act(async () => root.unmount());
  harness.asset = { _tag: "Initial" };
});
