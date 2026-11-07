import { expect, it } from "vite-plus/test";
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

it("typesets formulas with an unescaped percent sign inside \\text", async () => {
  await using screen = await render(
    <div>
      <MarkdownMath tex={"a+b % sum of the parts\n=c"} display />
      <MarkdownMath
        tex={
          "R_e=\\underbrace{\\frac{1.0176}{32}}_{\\text{3.18% dividend yield}}\n+\\underbrace{6\\%}_{\\text{growth}}\n=\\boxed{9.18\\%}"
        }
        display
      />
      <MarkdownMath tex={"p=\\text{5% off}"} display={false} />
    </div>,
  );
  const displays = screen.getByRole("group", { name: "Display equation" });
  // Typeset formulas start with their first symbol; the source fallback starts with its delimiter.
  await expect.element(displays.nth(0)).toMatchTextContent(/^a\+b=c/);
  await expect.element(displays.nth(1)).toMatchTextContent(/^R[\s\S]*3\.18%\sdividend yield/);
  await expect
    .element(screen.getByRole("group", { name: "Inline equation" }))
    .toMatchTextContent(/^p=[\s\S]*5%\soff/);
});
