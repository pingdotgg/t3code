import { expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import { StageBackdropArt } from "./SidebarStageBackdrop";

// Gradients and patterns resolve url(#id) document-wide, so a repeated id would paint one
// backdrop with another's definitions.
it.each(["nightly", "dev"] as const)(
  "gives every %s backdrop its own SVG definitions when two are on the page",
  async (variant) => {
    await using screen = await render(
      <>
        <StageBackdropArt variant={variant} />
        <StageBackdropArt variant={variant} />
      </>,
    );
    const [first, second] = screen.container.querySelectorAll("svg");
    const ids = (svg: Element | undefined) => [...svg!.querySelectorAll("[id]")].map((el) => el.id);

    expect(ids(first).length).toBeGreaterThan(0);
    for (const id of ids(first)) {
      expect(document.querySelectorAll(`#${CSS.escape(id)}`)).toHaveLength(1);
    }
    expect(ids(second).filter((id) => ids(first).includes(id))).toEqual([]);
    for (const reference of second!.querySelectorAll("[fill^='url(#'], [filter^='url(#']")) {
      const target = (reference.getAttribute("fill") ?? reference.getAttribute("filter"))!.slice(
        5,
        -1,
      );
      expect(second!.querySelector(`#${CSS.escape(target)}`)).not.toBeNull();
    }
  },
);
