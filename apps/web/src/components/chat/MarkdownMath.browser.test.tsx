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

it("typesets equations whose labels have an unescaped percent", async () => {
  // The reported multiline equation, line breaks included.
  const issue =
    "R_e=\\underbrace{\\frac{1.0176}{32}}_{\\text{3.18% dividend yield}}\n+\\underbrace{6\\%}_{\\text{growth}}\n=\\boxed{9.18\\%}";
  const typeset = [
    issue,
    "\\text{100%% yield}",
    "\\begin{aligned}x\\\\%\\end{aligned}",
    "\\begin{aligned}\nx &= 1 % +999\n\\\\ y &= \\text{2%}\n\\end{aligned}",
    "\\verb|50%|+\n\\text{2%}",
    "x % note\n+ 1",
  ];
  const raw = ["\\frac{1", "\\text{50 % off}", "\\verb|50%+\\text{2%}"];
  const equations = (tex: string[]) => tex.map((t) => <MarkdownMath key={t} tex={t} display />);
  await using screen = await render(<>{equations(typeset)}</>);
  const rendered = () => [...screen.container.querySelectorAll("[data-markdown-math]")];
  const visibleText = (index: number) =>
    rendered()[index]?.querySelector(".katex-html")?.textContent?.replaceAll("\u00a0", " ");
  await vi.waitFor(() => {
    for (const equation of rendered()) expect(equation.querySelector(".katex")).not.toBeNull();
  });
  expect(visibleText(0)).toContain("3.18% dividend yield");
  expect(visibleText(0)).toContain("9.18%");
  expect(rendered()[0]?.getAttribute("data-markdown-copy")).toBe(`\\[\n${issue}\n\\]\n\n`);
  expect(visibleText(1)).toContain("100%% yield");
  expect(visibleText(3)).toContain("2%");
  expect(visibleText(3)).not.toContain("999");
  expect(visibleText(4)).toContain("50%");
  expect(visibleText(4)).toContain("2%");
  expect(visibleText(5)).not.toContain("note");

  // KaTeX has loaded, so these render their final result in this commit.
  await screen.rerender(<>{equations([...typeset, ...raw])}</>);
  raw.forEach((tex, offset) => {
    const equation = rendered()[typeset.length + offset];
    expect(equation?.querySelector(".katex")).toBeNull();
    expect(equation?.textContent).toBe(`\\[\n${tex}\n\\]`);
  });
});
