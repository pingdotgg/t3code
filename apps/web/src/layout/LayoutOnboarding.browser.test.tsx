import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import "../index.css";
import { LayoutOnboarding } from "./LayoutOnboarding";
import { useLayoutStore } from "./layoutStore";

it("the tour's overview step does not count its own zoom-out as tried", async () => {
  localStorage.removeItem("t3code:layout-tour:v1");
  localStorage.removeItem("t3code:layout-learned:v1");
  await using _screen = await render(
    <>
      <div data-layout-strip="" />
      <LayoutOnboarding />
    </>,
  );
  await userEvent.click(page.getByRole("button", { name: "Show me" }));
  for (let step = 1; step <= 3; step++) {
    await expect.element(page.getByText(`${step} of 5`)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Next" }));
  }
  await expect.element(page.getByText("4 of 5")).toBeVisible();
  expect(useLayoutStore.getState().overviewOpen).toBe(true);
  await expect.element(page.getByText("Tried")).not.toBeInTheDocument();
});
