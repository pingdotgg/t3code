import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { Children, query } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  query: vi.fn(() => ({ data: null, error: null, refresh: vi.fn() })),
}));

vi.mock("react-native", () => ({ View: Children }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: query }));
vi.mock("../../state/skills", () => ({
  skillEnvironment: { reviewList: vi.fn(() => "skills-review-list") },
}));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ui/ListActionRow", () => ({ ListActionRow: () => null }));
vi.mock("../../components/ui/ListRow", () => ({ ListRow: () => null }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  AndroidSettingsEnvironmentFilter: () => null,
  SettingsEnvironmentFilterHeader: () => null,
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: [
      {
        environmentId: "environment:old-server",
        label: "Old server",
        serverConfig: { environment: { capabilities: {} } },
      },
    ],
  }),
}));

import { SettingsSkillsRouteScreen } from "./SettingsSkillsRouteScreen";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  query.mockClear();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

it("shows the upgrade message without querying an old server", () => {
  act(() => root.render(<SettingsSkillsRouteScreen />));

  expect(
    [...container.querySelectorAll("span")].some(
      (element) => element.textContent === "Update this server to use Skills",
    ),
  ).toBe(true);
  expect(query).toHaveBeenCalledExactlyOnceWith(null);
});
