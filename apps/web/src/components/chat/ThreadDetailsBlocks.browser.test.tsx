import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const saved = vi.hoisted(() => ({ order: [] as unknown }));
vi.mock(import("../../hooks/useSettings"), async (importOriginal) => ({
  ...(await importOriginal()),
  updateClientSettings: (async (patch: { threadDetailsOrder: unknown }) => {
    saved.order = patch.threadDetailsOrder;
  }) as never,
}));

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
const lineOn = () =>
  document.querySelector<HTMLElement>("[data-thread-details-drop-line]")?.parentElement?.dataset
    .threadDetailsBlockId;

it("marks the drop past a block that empties mid-drag, and keeps the section mounted", async () => {
  await using screen = await render(card(true));
  const scripts = page.getByText("Scripts").element();
  page.getByRole("button", { name: "Move Environment and worktree" }).element().focus();
  await userEvent.keyboard(" ");
  await screen.rerender(card(false));
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(lineOn).toBe("scripts");
  await userEvent.keyboard("{ArrowLeft}");
  expect(lineOn()).toBe("scripts");
  await userEvent.keyboard(" ");
  expect(saved.order).toEqual(["openIn", "scripts", "environment"]);
  await screen.rerender(card(false, ["scripts", "environment", "openIn"]));
  expect(scripts.isConnected).toBe(true);
});
