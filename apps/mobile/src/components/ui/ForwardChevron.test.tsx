import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

vi.mock("./AppSymbol", () => ({
  SymbolView: (props: { name: string }) => props.name,
}));

import { InterfaceDirectionContext } from "../../i18n/direction";
import { ForwardChevron } from "./ForwardChevron";

it.each([
  ["ltr", "chevron.right"],
  ["rtl", "chevron.left"],
] as const)("points toward the inline end in %s", (direction, name) => {
  expect(
    renderToStaticMarkup(
      <InterfaceDirectionContext value={direction}>
        <ForwardChevron size={12} />
      </InterfaceDirectionContext>,
    ),
  ).toBe(name);
});
