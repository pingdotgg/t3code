import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { act, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { ThreadMcpApp } from "./McpAppWebView";

type RelayEvent = { nativeEvent: { data: string } };
const native = vi.hoisted(() => ({
  receive: (_event: RelayEvent) => {},
  injectJavaScript: vi.fn(),
  openThread: vi.fn(),
  openExternal: vi.fn(),
  isFocused: vi.fn(() => true),
  alert: vi.fn<(title: string, message: string, buttons: Array<{ onPress: () => void }>) => void>(),
}));

vi.mock("react-native-webview", () => ({
  WebView({
    ref,
    onMessage,
  }: {
    ref: Ref<{ injectJavaScript: typeof native.injectJavaScript }>;
    onMessage: (event: RelayEvent) => void;
  }) {
    useImperativeHandle(ref, () => ({ injectJavaScript: native.injectJavaScript }), []);
    native.receive = onMessage;
    return null;
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({}) }));
vi.mock("expo-constants", () => ({ default: {} }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ isFocused: native.isFocused }),
}));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThread: () => native.openThread }));
vi.mock("../../components/ui/Dialog", () => ({ alert: native.alert }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: native.openExternal }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "relay-secret" }));
vi.mock("../../lib/attachmentDownload", () => ({ shareGeneratedAttachment: vi.fn() }));
vi.mock("../../lib/htmlRenderTheme", () => ({
  mobileHtmlRenderTheme: () => ({ appearance: "light", variables: {} }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({}),
}));
vi.mock("../../state/assets", () => ({
  useAssetUrlState: () => ({ _tag: "Success", url: "https://example.test/app" }),
}));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({}) }));
vi.mock("../../state/orchestration", () => ({ orchestrationEnvironment: { turnItem: vi.fn() } }));
vi.mock("../../state/mcpApps", () => ({ mcpAppEnvironment: { toolInfoQuery: vi.fn() } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/thread-outbox", () => ({ enqueueThreadOutboxMessage: vi.fn() }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { subscribe: () => () => {} } }));

it("opens a tapped thread and checks focus again after confirming a delayed relay request", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const threadId = ThreadId.make("source");
  const url = "https://app.t3.codes/threads/environment/target";
  const requestLink = (id: number, active: boolean) =>
    native.receive({
      nativeEvent: {
        data: JSON.stringify({
          secret: "relay-secret",
          active,
          message: { jsonrpc: "2.0", id, method: "ui/open-link", params: { url } },
        }),
      },
    });
  try {
    await act(async () =>
      root.render(
        <ThreadMcpApp
          environmentId={EnvironmentId.make("environment")}
          threadId={threadId}
          conversationThreadId={threadId}
          itemId={TurnItemId.make("item")}
          revision="1"
          width={390}
          app={{
            attachmentId: "attachment",
            server: "Demo",
            tool: "show",
            resourceUri: "ui://demo/app",
          }}
        />,
      ),
    );

    await act(async () => requestLink(1, true));
    expect(native.alert).not.toHaveBeenCalled();
    expect(native.openThread).toHaveBeenCalledExactlyOnceWith({
      environmentId: "environment",
      threadId: "target",
    });

    await act(async () => requestLink(2, false));
    expect(native.alert).toHaveBeenCalledTimes(1);
    expect(native.openThread).toHaveBeenCalledTimes(1);
    await act(async () => native.alert.mock.calls[0]![2][1]!.onPress());
    expect(native.openThread).toHaveBeenCalledTimes(2);

    await act(async () => requestLink(3, false));
    expect(native.alert).toHaveBeenCalledTimes(2);
    native.isFocused.mockReturnValue(false);
    await act(async () => native.alert.mock.calls[1]![2][1]!.onPress());
    expect(native.injectJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("Thread navigation is unavailable here."),
    );
    expect(native.openThread).toHaveBeenCalledTimes(2);
    expect(native.openExternal).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
