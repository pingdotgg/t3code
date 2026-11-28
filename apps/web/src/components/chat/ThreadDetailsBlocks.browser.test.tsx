import "~/index.css";

import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ThreadDetailsBlocks } from "./ThreadDetailsBlocks";

const row = (name: string) => <div style={{ height: 40 }}>{name}</div>;
const blocks = { environment: row("Environment"), scripts: row("Scripts") };
const card = (open: boolean, order = ["environment", "openIn", "scripts"]) => (
  <ThreadDetailsBlocks
    order={order as never}
    density="full"
    blocks={{ ...blocks, openIn: open && row("Open") } as never}
  />
);

it("skips a block that empties mid-drag and keeps a section mounted after a move", async () => {
  await using screen = await render(card(true));
  const top = (name: string) => page.getByText(name).element().getBoundingClientRect().top;
  const environmentTop = top("Environment");
  const scripts = page.getByText("Scripts").element();
  page.getByRole("button", { name: "Move Environment and worktree" }).element().focus();
  await userEvent.keyboard(" ");
  await screen.rerender(card(false));
  const scriptsTop = top("Scripts");
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => top("Scripts")).toBeCloseTo(environmentTop, 0);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => top("Scripts")).toBeCloseTo(scriptsTop, 0);
  page.getByRole("button", { name: "Move Project scripts" }).element().focus();
  await userEvent.keyboard(" ");
  await userEvent.keyboard("{ArrowLeft}");
  await expect.poll(() => top("Scripts")).toBeCloseTo(scriptsTop, 0);
  await screen.rerender(card(false, ["scripts", "environment", "openIn"]));
  expect(scripts.isConnected).toBe(true);
});
