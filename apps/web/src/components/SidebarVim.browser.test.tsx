import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import stylesheet from "~/index.css?inline";
import { startWorkspaceFocus } from "~/lib/workspaceFocus";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

it.each([1280, 600])(
  "navigates the sidebar tree and its action menus from Vim at %ipx without losing the draft",
  async (width) => {
    const style = document.createElement("style");
    style.textContent = stylesheet;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await page.viewport(width, 800);
    const first = threadWithHistory("vim-sidebar-a", 1);
    const second = threadWithHistory("vim-sidebar-b", 1);
    using _environment = installFakeEnvironment([first, second]);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: true,
      vimModeEnabled: true,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const history = createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] });
    const router = getRouter(history);
    await router.load();
    await using _app = await render(<AppRoot router={router} />, {
      router: false,
    });
    using _focus = { [Symbol.dispose]: startWorkspaceFocus(router) };
    const activeThread = page.getByTestId("sidebar-row-folder").filter({ hasText: first.title });
    await expect.element(activeThread).toHaveAttribute("aria-current", "page");
    const editor = page.getByTestId("composer-editor");
    const toggle = page.getByRole("button", { name: "Toggle main sidebar", exact: true });
    if (width === 1280 && toggle.element().getAttribute("aria-pressed") === "true")
      await toggle.click();
    if (width === 600) await page.getByRole("button", { name: "Expand composer" }).click();
    await userEvent.clear(editor);
    await userEvent.click(editor);
    await userEvent.keyboard("draft{ArrowLeft}{Escape}gd");
    const row = () => document.activeElement as HTMLElement;
    await vi.waitFor(() => expect(row().dataset.sidebarRow).toContain(first.id));
    const currentKey = row().dataset.sidebarRow;
    await userEvent.keyboard("h");
    const group = row();
    expect(group.getAttribute("aria-expanded")).toBe("true");
    await userEvent.keyboard("h");
    await expect.element(group).toHaveAttribute("aria-expanded", "false");
    await userEvent.keyboard("ll");
    await vi.waitFor(() => expect(row().dataset.sidebarParent).toBe(group.dataset.sidebarRow));
    await userEvent.keyboard("Gj");
    expect(row().getAttribute("aria-label")).toBe("Settings");
    await userEvent.keyboard("kgg");
    expect(row()).toBe(group);
    await userEvent.keyboard("m");
    const newThread = page.getByRole("menuitem", { name: "New thread", exact: true });
    const copyPath = page.getByRole("menuitem", { name: "Copy path", exact: true });
    await expect.element(newThread).toHaveFocus();
    await userEvent.keyboard("j");
    await expect.element(copyPath).toHaveFocus();
    expect(getComputedStyle(copyPath.element()).outlineStyle).toBe("solid");
    await userEvent.keyboard("k{Escape}");
    await vi.waitFor(() => expect(row()).toBe(group));
    await userEvent.keyboard("/hjkl");
    const search = page.getByRole("combobox", { name: "Search threads" });
    await expect.element(search).toHaveValue("hjkl");
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(row().dataset.sidebarRow).toContain(first.id));
    await userEvent.keyboard("hj");
    await vi.waitFor(() => expect(row().dataset.sidebarParent).toBe(group.dataset.sidebarRow));
    if (row().dataset.sidebarRow === currentKey) await userEvent.keyboard("j");
    expect(row().dataset.sidebarRow).toContain(second.id);
    expect(history.location.pathname).toBe(`/${ENVIRONMENT_ID}/${first.id}`);
    await userEvent.keyboard("i");
    await expect.element(editor).toHaveFocus();
    await userEvent.keyboard("!");
    expect(editor.element().textContent).toBe("draf!t");
    await userEvent.keyboard("{Escape}gd");
    await vi.waitFor(() => expect(row().dataset.sidebarRow).toBe(currentKey));
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("button", { name: "Return to typing" })).toHaveFocus();
    await userEvent.keyboard("gd");
    await vi.waitFor(() => expect(row().dataset.sidebarRow).toBe(currentKey));
    await userEvent.keyboard("ggl");
    if (row().dataset.sidebarRow === currentKey) await userEvent.keyboard("j");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(history.location.pathname).toBe(`/${ENVIRONMENT_ID}/${second.id}`),
    );
  },
);
