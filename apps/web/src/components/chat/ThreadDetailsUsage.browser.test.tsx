import "~/index.css";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { deriveLatestContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { render } from "../../../test/render";
import { ThreadDetailsContext } from "./ThreadDetailsUsage";

it("fits reported context and token totals in a narrow details card", async () => {
  const usage = deriveLatestContextWindowSnapshot([], {
    usedTokens: 80000,
    maxTokens: 1000000,
    inputTokens: 911100,
    cachedInputTokens: 870000,
    outputTokens: 10600,
    autoCompactThreshold: 900000,
    updatedAt: "2026-11-18T00:00:00Z",
  })!;
  await using screen = await render(
    <div data-testid="context-card" style={{ width: 308 }}>
      <ThreadDetailsContext usage={usage} />
    </div>,
  );
  await expect
    .element(page.getByRole("progressbar", { name: "Context usage" }))
    .toHaveAttribute("aria-valuenow", "8");
  await expect.element(page.getByText("Reported usage")).toBeVisible();
  const card = screen.getByTestId("context-card").element();
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
});
