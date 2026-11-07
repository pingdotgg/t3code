import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  updateClientSettings,
} from "../hooks/useSettings";
import { AppSidebarLayout } from "./AppSidebarLayout";

vi.mock("../env", () => ({ isElectron: true }));
vi.mock("./Sidebar", () => ({ default: () => null }));
vi.mock("./BackgroundThreadAnnouncer", () => ({ BackgroundThreadAnnouncer: () => null }));
vi.mock("./sidebar/SidebarChrome", () => ({ SidebarBrandWidthProbe: () => null }));
vi.mock("../localApi", () => ({
  ensureLocalApi: () => ({
    persistence: { setClientSettings: async () => undefined },
  }),
}));

function setup(historySwipeNavigation: boolean) {
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, historySwipeNavigation });
}

function wheel(deltaX: number) {
  window.dispatchEvent(new WheelEvent("wheel", { deltaX, clientY: 200 }));
}

describe("desktop history swipe navigation", () => {
  it.each(["back", "forward"] as const)(
    "disables %s swipes and can re-enable them without reloading",
    async (direction) => {
      setup(false);
      using _available = vi
        .spyOn(window.navigation, direction === "back" ? "canGoBack" : "canGoForward", "get")
        .mockReturnValue(true);
      await using screen = await render(<AppSidebarLayout>Thread</AppSidebarLayout>);
      using navigate = vi.spyOn(window.history, direction).mockImplementation(() => undefined);
      const deltaX = direction === "back" ? -140 : 140;

      await act(() => {
        wheel(deltaX);
        wheel(0);
      });
      expect(navigate).not.toHaveBeenCalled();
      await expect.element(screen.getByTestId("history-swipe-indicator")).not.toBeInTheDocument();

      await act(() => updateClientSettings({ historySwipeNavigation: true }));
      await act(() => wheel(deltaX));
      await expect.element(screen.getByTestId("history-swipe-indicator")).toBeInTheDocument();

      await act(() => updateClientSettings({ historySwipeNavigation: false }));
      await expect.element(screen.getByTestId("history-swipe-indicator")).not.toBeInTheDocument();
      await act(() => wheel(0));
      expect(navigate).not.toHaveBeenCalled();

      await act(() => updateClientSettings({ historySwipeNavigation: true }));
      await act(() => {
        wheel(deltaX);
        wheel(0);
      });
      expect(navigate).toHaveBeenCalledOnce();
    },
  );
});
