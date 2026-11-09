import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { registerPluginReplacement } from "../plugins/pluginRegistry";
import { pluginUiAtom } from "../plugins/pluginUi";
import { pluginUi } from "../plugins/pluginUiParts";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { AppRouteHeader, AppRouteModal, AppRouteModalNav } from "./AppRouteModal";
import { shownAppPageAtom } from "./sidebar/mainAppLocation";
import { SidebarProvider } from "./ui/sidebar";

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

describe("AppRouteModal", () => {
  it("commits a focused field when Esc closes it", async () => {
    const onCommit = vi.fn();
    await using _screen = await render(
      <AppRouteModal page="settings" label="Settings">
        <CommitOnBlurField onCommit={onCommit} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
  });

  it("shows a plugin's page frame without a dialog or section list, and Esc commits a focused field there too", async () => {
    // As the plugin loader does once a plugin with a web part is active.
    appAtomRegistry.set(pluginUiAtom, pluginUi);
    using _ui = { [Symbol.dispose]: () => appAtomRegistry.set(pluginUiAtom, null) };
    using _frame = {
      [Symbol.dispose]: registerPluginReplacement("app.pageFrame", (frame) => frame.page, {
        environmentId: EnvironmentId.make("environment:frame"),
        pluginId: "pages",
        pluginName: "Pages",
      }),
    };
    const onCommit = vi.fn();
    await using screen = await render(
      <AppAtomRegistryProvider>
        <SidebarProvider>
          <AppRouteModal page="settings" label="Settings" nav={<p>Settings sections</p>}>
            <AppRouteModalNav />
            <AppRouteHeader>Settings</AppRouteHeader>
            <CommitOnBlurField onCommit={onCommit} />
          </AppRouteModal>
        </SidebarProvider>
      </AppAtomRegistryProvider>,
      { router: "/settings/general" },
    );

    await expect.element(page.getByRole("button", { name: "Close" })).toBeVisible();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    // The sidebar draws the section list instead, and learns which page it sits beside.
    await expect.element(page.getByText("Settings sections")).not.toBeInTheDocument();
    expect(appAtomRegistry.get(shownAppPageAtom)).toBe("settings");
    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/"));
  });
});
