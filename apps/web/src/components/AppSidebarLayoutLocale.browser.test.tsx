import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { i18n } from "../i18nCore";

vi.mock(import("./Sidebar"), async (original) => ({
  ...(await original()),
  default: (() => <div data-testid="thread-sidebar-stub" />) as never,
}));
vi.mock(import("./BackgroundThreadAnnouncer"), () => ({
  BackgroundThreadAnnouncer: (() => null) as never,
}));
vi.mock(import("./sidebar/SidebarChrome"), async (original) => ({
  ...(await original()),
  SidebarBrandWidthProbe: (() => null) as never,
}));
vi.mock(import("./SidebarStageBackdrop"), async (original) => ({
  ...(await original()),
  useSidebarStageBackdropVariant: (() => null) as never,
}));
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentIdentificationMode: (() => "artwork") as never,
}));
vi.mock(import("../panelAnimations"), async (original) => ({
  ...(await original()),
  usePanelAnimationSettings: (() => ({ active: false, durationMs: 0 })) as never,
  usePanelNavigationSuppression: (() => false) as never,
}));

import { AppSidebarLayout } from "./AppSidebarLayout";

it("updates sidebar control labels when the language changes without remounting", async () => {
  await i18n.changeLanguage("en");
  await using screen = await render(<AppSidebarLayout>{null}</AppSidebarLayout>, {
    router: "/threads/1",
  });
  const trigger = screen.container.querySelector<HTMLElement>("[data-sidebar-control] button");
  expect(trigger?.getAttribute("aria-label")).toBe("Toggle main sidebar");

  await act(() => i18n.changeLanguage("zh-Hans"));

  expect(
    screen.container
      .querySelector<HTMLElement>("[data-sidebar-control] button")
      ?.getAttribute("aria-label"),
  ).toBe("切换主侧栏");
  await act(() => i18n.changeLanguage("en"));
});
