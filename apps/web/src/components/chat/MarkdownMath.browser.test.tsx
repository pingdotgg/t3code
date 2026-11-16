import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

import { MarkdownMath } from "./MarkdownMath";

it("mounts equations without reading layout mid-commit and still finds the one that overflows", async () => {
  using scrollWidth = vi.spyOn(Element.prototype, "scrollWidth", "get");
  let readsDuringCommit: number | null = null;
  await using screen = await render(
    <div style={{ width: 180 }}>
      <MarkdownMath tex="x" display />
      <MarkdownMath tex="x_1 + x_2 + x_3 + x_4 + x_5 + x_6 + x_7 + x_8" display />
      {/* Refs attach in tree order, after the equations' layout effects. */}
      <span
        ref={() => {
          readsDuringCommit ??= scrollWidth.mock.calls.length;
        }}
      />
    </div>,
    { router: false },
  );

  expect(readsDuringCommit).toBe(0);
  await expect
    .element(screen.getByLabelText("Scroll display equation"))
    .toHaveAttribute("tabindex", "0");
});

it("keeps keyboard scrolling available as a streamed equation outgrows its viewport", async () => {
  const equation = (tex: string, width = 180) => (
    <div style={{ width }}>
      <button>Before equation</button>
      <MarkdownMath tex={tex} display />
      <button>After equation</button>
    </div>
  );
  await using screen = await render(equation("x"));
  await screen.getByRole("button", { name: "Before equation" }).click();
  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByRole("button", { name: "After equation" })).toHaveFocus();

  await screen.rerender(equation("x_1 + x_2 + x_3 + x_4 + x_5 + x_6 + x_7 + x_8"));
  const scroller = screen.getByLabelText("Scroll display equation");
  await expect.element(scroller).toHaveAttribute("tabindex", "0");
  await screen.getByRole("button", { name: "Before equation" }).click();
  await userEvent.keyboard("{Tab}");
  await expect.element(scroller).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(scroller).not.toHaveProperty("scrollLeft", 0);

  await screen.rerender(equation("x_1 + x_2 + x_3 + x_4 + x_5 + x_6 + x_7 + x_8", 1000));
  await expect.element(screen.getByLabelText("Scroll display equation")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Before equation" }).click();
  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByRole("button", { name: "After equation" })).toHaveFocus();
});
