import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { Children, loaded } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => <>{children}</>,
  loaded: [] as string[],
}));

vi.mock("react-native", () => ({ View: Children }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: Children }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: vi.fn() }) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../state/entities", () => ({ useEnvironmentPreviewTunnelOff: () => false }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ presentationById: new Map() }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));
vi.mock("./BrowserBar", () => ({
  BrowserChrome: (props: {
    children: (page: { topInset: number; onScrollDirection: () => void }) => ReactNode;
  }) => <>{props.children({ topInset: 0, onScrollDirection: () => {} })}</>,
}));
vi.mock("./TunnelWebView", () => ({
  TunnelWebView: ({ url }: { url: string }) => {
    loaded.push(url);
    return null;
  },
}));

import { LocalPreviewRouteScreen } from "./LocalPreviewRouteScreen";

it("gives the webview only web addresses from the route, on open and on a later link", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const show = (url: string) => {
    loaded.length = 0;
    act(() =>
      root.render(<LocalPreviewRouteScreen route={{ params: { environmentId: "env-1", url } }} />),
    );
    return loaded.at(-1);
  };

  try {
    expect(show("http://0.0.0.0:5173/app")).toBe("http://localhost:5173/app");
    expect(show("javascript:document.title='x'")).toBe("");
    expect(show("https://example.com/docs")).toBe("https://example.com/docs");
    expect(show("file:///data/local/tmp/a.html")).toBe("");
    expect(show("intent://example.com#Intent;scheme=http;end")).toBe("");
  } finally {
    act(() => root.unmount());
  }
});
