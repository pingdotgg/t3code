import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

import { MarkdownMath } from "./MarkdownMath";

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

it("typesets a display equation whose label has an unescaped percent", async () => {
  const tex =
    "R_e=\\underbrace{\\frac{1.0176}{32}}_{\\text{3.18% dividend yield}}+\\underbrace{6\\%}_{\\text{growth}}=\\boxed{9.18\\%}";
  const adjacent = "\\text{100%% yield}";
  const paired = "\\begin{aligned}x\\\\%\\end{aligned}";
  const commented = "\\begin{aligned}\nx &= 1 % +999\n\\\\ y &= \\text{2%}\n\\end{aligned}";
  await using screen = await render(
    <>
      <MarkdownMath tex={tex} display />
      <MarkdownMath tex={adjacent} display />
      <MarkdownMath tex={paired} display />
      <MarkdownMath tex={commented} display />
    </>,
  );
  await vi.waitFor(() => expect(screen.container.querySelector(".katex")).not.toBeNull());
  const text = screen.container.textContent ?? "";
  expect(text).toContain("9.18%");
  expect(text.replaceAll("\u00a0", " ")).toContain("3.18% dividend yield");
  const equations = screen.container.querySelectorAll("[data-markdown-math]");
  expect(equations[0]?.querySelector(".katex")).not.toBeNull();
  expect(equations[1]?.querySelector(".katex")).not.toBeNull();
  expect(equations[1]?.textContent?.replaceAll("\u00a0", " ")).toContain("100%% yield");
  expect(equations[2]?.querySelector(".katex")).not.toBeNull();
  expect(equations[3]?.querySelector(".katex")).toBeNull();
  expect(equations[3]?.textContent).toBe(`\\[\n${commented}\n\\]`);
  expect(equations[0]?.getAttribute("data-markdown-copy")).toBe(`\\[\n${tex}\n\\]\n\n`);
});
