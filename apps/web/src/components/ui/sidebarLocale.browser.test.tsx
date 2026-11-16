import { expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { i18n } from "../../i18nCore";
import { SidebarProvider, SidebarTrigger } from "./sidebar";

it("updates the sidebar trigger label when the language changes without remounting", async () => {
  await i18n.changeLanguage("en");
  await using screen = await render(
    <SidebarProvider>
      <SidebarTrigger />
    </SidebarProvider>,
    { router: false /* no routes involved */ },
  );
  expect(screen.container.querySelector(".sr-only")?.textContent).toBe("Toggle Sidebar");

  await act(() => i18n.changeLanguage("zh-Hans"));

  expect(screen.container.querySelector(".sr-only")?.textContent).toBe("切换侧边栏");
  await act(() => i18n.changeLanguage("en"));
});
