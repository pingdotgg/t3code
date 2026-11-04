import "../index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { AppRouteModal, AppRouteModalClose } from "./AppRouteModal";
import { startMainAppLocationTracking } from "./sidebar/mainAppLocation";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

describe("AppRouteModal", () => {
  it("commits a focused field when Esc closes it", async () => {
    const onCommit = vi.fn();
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <CommitOnBlurField onCommit={onCommit} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
  });
});

it.each(["Close", "Escape"])(
  "returns from History to the opening thread on %s",
  async (dismiss) => {
    const root = createRootRoute();
    const thread = createRoute({
      getParentRoute: () => root,
      path: "/$environmentId/$threadId",
      component: () => <div>Original thread</div>,
    });
    const history = createRoute({
      getParentRoute: () => root,
      path: "/history",
      component: () => (
        <AppRouteModal label="Agent history">
          <AppRouteModalClose />
        </AppRouteModal>
      ),
    });
    const originalHref = "/homebase/original-thread?view=activity";
    const router = createRouter({
      routeTree: root.addChildren([thread, history]),
      history: createMemoryHistory({ initialEntries: [originalHref] }),
    });
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };
    // Own the router to exercise the same return-location tracking as the app.
    await using screen = await render(<RouterProvider router={router} />, { router: false });
    await expect.element(screen.getByText("Original thread")).toBeVisible();
    await act(() => router.navigate({ to: "/history" }));
    await expect.element(page.getByRole("dialog", { name: "Agent history" })).toBeVisible();
    if (dismiss === "Close") await page.getByRole("button", { name: "Close", exact: true }).click();
    else await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByText("Original thread")).toBeVisible();
    expect(router.state.location.href).toBe(originalHref);
  },
);
