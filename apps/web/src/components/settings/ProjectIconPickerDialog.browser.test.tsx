import "~/index.css";

import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ProjectIconPickerDialog } from "./ProjectIconPickerDialog";

function verticalPosition(element: HTMLElement | SVGElement): number {
  return Math.round(element.getBoundingClientRect().top);
}

it("keeps the search field still while the result count changes", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1024, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  await using _screen = await render(
    <ProjectIconPickerDialog
      current={null}
      projectName="t3code"
      open
      onOpenChange={() => {}}
      onSelect={() => {}}
    />,
    { router: false },
  );

  const search = page.getByRole("searchbox", { name: "Search Lucide icons" });
  await expect.element(search).toBeVisible();
  const restingTop = verticalPosition(search.element());

  // One row, no results, and back to the full list.
  for (const query of ["folder-code", "zzzzzzzz", ""]) {
    await userEvent.clear(search);
    if (query) await userEvent.fill(search, query);
    await expect.element(search).toHaveValue(query);
    expect(verticalPosition(search.element())).toBe(restingTop);
  }
});
