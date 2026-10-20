import { render as renderUi } from "../../../test/render";
import "../../index.css";

import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

it("expands even a short JSON error to its exact diagnostics and collapses back to its message", async () => {
  const error = '  {"error": {"message":"Turn failed", "code":"unsupported_value"}}\t ';

  await using screen = await renderUi(<ThreadErrorBanner error={error} />);
  const { container } = screen;

  await expect.element(page.getByText("Turn failed", { exact: true })).toBeVisible();
  expect(container.textContent).not.toContain("unsupported_value");

  await page.getByRole("button", { name: "Show full error" }).click();

  const diagnostics = page.getByText(error, { exact: true });
  await expect.element(diagnostics).toBeVisible();
  expect(diagnostics.element().textContent).toBe(error);

  await page.getByRole("button", { name: "Show less" }).click();

  await expect.element(page.getByText("Turn failed", { exact: true })).toBeVisible();
  expect(container.textContent).not.toContain("unsupported_value");
});
