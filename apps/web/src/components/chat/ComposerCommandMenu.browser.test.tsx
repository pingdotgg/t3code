import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

const LONG = "A description long enough to be cut off in a narrow menu row";
const items: ComposerCommandItem[] = Array.from({ length: 30 }, (_, index) => ({
  id: `command:${index}`,
  type: "slash-command",
  command: "model",
  label: `/command-${index}`,
  description: `${LONG} ${index}`,
}));

function Menu(props: { activeItemId: string }) {
  return (
    <div className="w-80">
      <ComposerCommandMenu
        listId="suggestions"
        items={items}
        resolvedTheme="light"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId={props.activeItemId}
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />
    </div>
  );
}

const tooltipText = () =>
  document.querySelector('[data-slot="tooltip-popup"]:not([data-ending-style])')?.textContent ??
  null;
const viewport = () => document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;

it("closes the highlighted row's description tooltip when the menu scrolls", async () => {
  await using _screen = await render(<Menu activeItemId="command:0" />);
  await vi.waitFor(() => expect(tooltipText()).toBe(`${LONG} 0`));

  viewport().scrollTop = 40;
  await vi.waitFor(() => expect(tooltipText()).toBeNull());
});

it("keeps the tooltip open when highlighting scrolls a row into view", async () => {
  await using screen = await render(<Menu activeItemId="command:0" />);
  await vi.waitFor(() => expect(tooltipText()).toBe(`${LONG} 0`));

  const onScroll = vi.fn();
  viewport().addEventListener("scroll", onScroll);
  await screen.rerender(<Menu activeItemId="command:25" />);
  await vi.waitFor(() => expect(onScroll).toHaveBeenCalled());
  expect(tooltipText()).toBe(`${LONG} 25`);
});
