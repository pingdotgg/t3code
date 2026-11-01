import { ProviderDriverKind } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "~/index.css";
import {
  ComposerCommandMenu,
  composerSuggestionOptionId,
  type ComposerCommandItem,
} from "./ComposerCommandMenu";

const skillItems: ComposerCommandItem[] = Array.from({ length: 300 }, (_, index) => {
  const name = `demo-skill-${String(index).padStart(3, "0")}`;
  return {
    id: `skill:codex:${name}`,
    type: "skill",
    provider: ProviderDriverKind.make("codex"),
    skill: {
      name,
      description: `Demo skill ${index}`,
      path: `/repo/.agents/skills/${name}/SKILL.md`,
      scope: "project",
      enabled: true,
    },
    label: name,
    description: `Demo skill ${index}`,
  };
});

function Menu({
  activeItemId,
  items = skillItems,
}: {
  activeItemId: string | null;
  items?: ComposerCommandItem[];
}) {
  return (
    <ComposerCommandMenu
      listId="composer-suggestions"
      items={items}
      resolvedTheme="light"
      isLoading={false}
      triggerKind="slash-command"
      activeItemId={activeItemId}
      onHighlightedItemChange={() => {}}
      onSelect={() => {}}
    />
  );
}

it("mounts only the rows near the visible window of a long skill list", async () => {
  await using screen = await render(<Menu activeItemId={null} />);
  await expect.element(page.getByRole("option", { name: /Demo Skill 000/ })).toBeVisible();

  const mountedRows = screen.container.querySelectorAll("[data-composer-item-id]").length;
  expect(mountedRows, "rows mounted for 300 skills").toBeLessThan(50);
});

it("fills the visible list with rows in the first frame it paints", async () => {
  const container = document.createElement("div");
  let firstFrame: { rowsBottom: number; listBottom: number } | undefined;
  // Mutation callbacks run before the next paint, so the first one with rows sees the first frame.
  const observer = new MutationObserver(() => {
    const list = container.querySelector("[role=listbox]");
    const rows = container.querySelectorAll("[data-composer-item-id]");
    if (firstFrame || !list || rows.length === 0) return;
    firstFrame = {
      rowsBottom: Math.max(...Array.from(rows, (row) => row.getBoundingClientRect().bottom)),
      listBottom: list.getBoundingClientRect().bottom,
    };
  });
  observer.observe(container, { childList: true, subtree: true });
  using _observer = { [Symbol.dispose]: () => observer.disconnect() };
  await using _screen = await render(<Menu activeItemId={null} />, { container });

  expect(firstFrame?.rowsBottom, "bottom of the first frame's last row").toBeGreaterThanOrEqual(
    firstFrame!.listBottom,
  );
});

it("brings a highlighted row far down a long list into the visible window", async () => {
  await using screen = await render(<Menu activeItemId={null} />);
  await expect.element(page.getByRole("option", { name: /Demo Skill 000/ })).toBeVisible();
  await screen.rerender(<Menu activeItemId={skillItems[250]!.id} />);

  const option = page.getByRole("option", { name: /Demo Skill 250/ });
  await expect.element(option).toBeInViewport();
  await expect.element(option).toHaveAttribute("aria-posinset", "251");
  await expect.element(option).toHaveAttribute("aria-setsize", "300");
});

async function scrollListToEnd() {
  const firstRow = page.getByRole("option", { name: /Demo Skill 000/ });
  await expect.element(firstRow).toBeVisible();
  let scroller = firstRow.element().parentElement;
  while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
    scroller = scroller.parentElement;
  }
  if (!scroller) throw new Error("list scroller not found");
  scroller.scrollTop = scroller.scrollHeight;
  await expect.element(page.getByRole("option", { name: /Demo Skill 299/ })).toBeInViewport();
}

it("shows the first row when filtering a scrolled list highlights it", async () => {
  await using screen = await render(<Menu activeItemId={skillItems[0]!.id} />);
  await scrollListToEnd();
  const filtered = skillItems.filter((item) => item.label.endsWith("3"));
  await screen.rerender(<Menu activeItemId={filtered[0]!.id} items={filtered} />);

  await expect.element(page.getByRole("option", { name: /Demo Skill 003/ })).toBeInViewport();
});

it("keeps the highlighted option mounted while the list scrolls away from it", async () => {
  await using _screen = await render(<Menu activeItemId={skillItems[0]!.id} />);
  await scrollListToEnd();

  expect(
    document.getElementById(composerSuggestionOptionId("composer-suggestions", skillItems[0]!.id)),
    "aria-activedescendant target",
  ).not.toBeNull();
});
