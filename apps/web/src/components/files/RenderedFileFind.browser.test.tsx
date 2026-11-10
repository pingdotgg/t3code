import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "~/index.css";

import { RenderedFileFind } from "./RenderedFileFind";

it("opens find on the find shortcut and steps through rendered matches", async () => {
  await using screen = await render(
    <RenderedFileFind>
      <h1>Alpha notes</h1>
      <p>
        One <strong>alp</strong>ha, then another alpha.
      </p>
    </RenderedFileFind>,
    { router: false }, // The find surface reads no route.
  );
  await userEvent.click(screen.getByText("Alpha notes"));
  await userEvent.keyboard(
    navigator.platform.includes("Mac") ? "{Meta>}f{/Meta}" : "{Control>}f{/Control}",
  );

  const find = screen.getByRole("searchbox", { name: "Find in file" });
  await expect.element(find).toHaveFocus();
  await userEvent.keyboard("alpha");
  await expect.element(screen.getByText("1/3")).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByText("2/3")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(find).not.toBeInTheDocument();
});
