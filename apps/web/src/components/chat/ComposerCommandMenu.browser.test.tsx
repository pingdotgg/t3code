import { ProviderDriverKind } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
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

const option = (index: number) =>
  page.getByRole("option", { name: skillItems[index]!.label, exact: false });

function listScroller() {
  const scroller = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
  if (!scroller) throw new Error("list scroller not found");
  return scroller;
}

it("mounts a window of a long list and sizes a short one to its rows", async () => {
  await using screen = await render(<Menu activeItemId={skillItems[0]!.id} />);
  await expect.element(option(0)).toBeInViewport();
  expect(
    screen.container.querySelectorAll("[data-composer-item-id]").length,
    "rows mounted for 300 skills",
  ).toBeLessThan(50);

  await screen.rerender(<Menu activeItemId={skillItems[0]!.id} items={skillItems.slice(0, 5)} />);
  await expect.element(option(4)).toBeInViewport();
  const scroller = listScroller();
  expect(scroller.scrollHeight, "short list overflow").toBe(scroller.clientHeight);
});

it("brings a highlighted row far down the list into view, clear of the scroll fade", async () => {
  await using screen = await render(<Menu activeItemId={skillItems[0]!.id} />);
  await expect.element(option(0)).toBeInViewport();
  await screen.rerender(<Menu activeItemId={skillItems[250]!.id} />);

  await expect.element(option(250)).toHaveAttribute("aria-posinset", "251");
  await expect.element(option(250)).toHaveAttribute("aria-setsize", "300");
  const scrollerRect = listScroller().getBoundingClientRect();
  await vi.waitFor(() => {
    const rowRect = option(250).element().getBoundingClientRect();
    expect(rowRect.top, "row top").toBeGreaterThanOrEqual(scrollerRect.top + 24);
    expect(rowRect.bottom, "row bottom").toBeLessThanOrEqual(scrollerRect.bottom - 24);
  });
});

async function scrollListToEnd() {
  const scroller = listScroller();
  // Row heights are estimates until measured, so the end moves while the list scrolls to it.
  await vi.waitFor(() => {
    scroller.scrollTop = scroller.scrollHeight;
    expect(option(299).query(), "last row").not.toBeNull();
  });
}

it("keeps the highlighted option mounted while the list scrolls away from it", async () => {
  await using _screen = await render(<Menu activeItemId={skillItems[0]!.id} />);
  await expect.element(option(0)).toBeInViewport();
  await scrollListToEnd();

  expect(
    document.getElementById(composerSuggestionOptionId("composer-suggestions", skillItems[0]!.id)),
    "aria-activedescendant target",
  ).not.toBeNull();
});

it("shows the first row when filtering a scrolled list highlights it", async () => {
  await using screen = await render(<Menu activeItemId={skillItems[0]!.id} />);
  await expect.element(option(0)).toBeInViewport();
  await scrollListToEnd();

  const filtered = skillItems.filter((item) => item.label.endsWith("3"));
  await screen.rerender(<Menu activeItemId={filtered[0]!.id} items={filtered} />);

  await expect.element(option(3)).toBeInViewport();
  expect(listScroller().scrollTop, "scroll offset").toBe(0);
});
