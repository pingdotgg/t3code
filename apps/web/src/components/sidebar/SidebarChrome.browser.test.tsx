import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarChromeFooter } from "./SidebarChrome";

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePullRequestsSupported: () => true,
  useIssuesSupported: () => true,
}));
vi.mock("./SidebarThreadUndoNotice", () => ({ SidebarThreadUndoNotice: () => null }));
vi.mock("./SidebarProviderUpdatePill", () => ({ SidebarProviderUpdatePill: () => null }));
vi.mock("./SidebarUpdatePill", () => ({
  SidebarUpdateArchitectureWarning: () => null,
  SidebarUpdatePill: () => null,
}));

it.each(["/pull-requests", "/issues"])(
  "keeps the utility bar usable when entering at %s",
  async (path) => {
    await page.viewport(1280, 800);
    await using screen = await render(
      <SidebarProvider defaultOpen>
        <SidebarChromeFooter />
      </SidebarProvider>,
      { router: path },
    );

    for (const [name, pathname] of [
      ["Issues", "/issues"],
      ["Pull requests", "/pull-requests"],
      ["Settings", "/settings"],
      ["Usage", "/usage"],
    ] as const) {
      await userEvent.click(screen.getByRole("button", { name, exact: true }));
      await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe(pathname));
      await expect
        .element(screen.getByRole("button", { name: "Issues", exact: true }))
        .toBeVisible();
      await expect
        .element(screen.getByRole("button", { name: "Pull requests", exact: true }))
        .toBeVisible();
    }
  },
);
