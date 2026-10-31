import { lazy, Suspense } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { RightPanelContentBoundary } from "./RightPanelContentBoundary";

it("contains a failed panel download and recovers when another surface opens", async () => {
  using _error = vi.spyOn(console, "error").mockImplementation(() => {});
  const FailedPanel = lazy(async () => {
    throw new Error("Panel download failed");
  });
  await using screen = await render(
    <>
      <main>Running chat</main>
      <RightPanelContentBoundary surfaceId="failed-pr">
        <Suspense fallback={<span>Loading panel</span>}>
          <FailedPanel />
        </Suspense>
      </RightPanelContentBoundary>
    </>,
  );
  await expect.element(screen.getByRole("button", { name: "Reload app" })).toBeVisible();
  await expect.element(screen.getByRole("main")).toHaveTextContent("Running chat");

  await screen.rerender(
    <>
      <main>Running chat</main>
      <RightPanelContentBoundary surfaceId="other-panel">
        <p>Other panel</p>
      </RightPanelContentBoundary>
    </>,
  );
  await expect.element(screen.getByText("Other panel", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("main")).toHaveTextContent("Running chat");
});
