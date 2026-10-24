import { act, render as renderScreen } from "../../../test/render";
import { useState, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { SideChatPortal } from "./SideChatPortal";

vi.mock("./SideChatPanel", () => ({
  SideChat: ({ visible }: { visible: boolean }) => {
    const [draft, setDraft] = useState(0);
    return (
      <button disabled={!visible} onClick={() => setDraft(draft + 1)}>
        Draft {draft}
      </button>
    );
  },
}));

it("preserves each composer's state across hidden, switched and recreated panel slots", async () => {
  await using screen = await renderScreen(null);
  const first = document.createElement("div");
  const second = document.createElement("div");
  const props = {} as Omit<ComponentProps<typeof SideChatPortal>, "target">;
  const render = (target: HTMLElement | null) =>
    act(async () => {
      screen.rerender(<SideChatPortal {...props} target={target} />);
    });
  await render(first);
  const composer = first.querySelector("button")!;
  await act(async () => composer.click());
  expect(composer.textContent).toBe("Draft 1");
  await render(null);
  expect(first.childElementCount).toBe(0);
  expect(composer.disabled).toBe(true);
  await render(second);
  expect(second.querySelector("button")).toBe(composer);
  expect(composer.textContent).toBe("Draft 1");
  expect(composer.disabled).toBe(false);
});

it("shows only the selected parent's composer and restores each independent draft", async () => {
  await using screen = await renderScreen(null);
  const slot = document.createElement("div");
  const props = {} as Omit<ComponentProps<typeof SideChatPortal>, "target">;
  // Include identical thread IDs on different environments.
  const parents = ["local:one", "local:two", "remote:one"];
  const render = (active: string | null) =>
    act(async () => {
      screen.rerender(
        <>
          {parents.map((parent) => (
            <SideChatPortal key={parent} {...props} target={parent === active ? slot : null} />
          ))}
        </>,
      );
    });
  await render(parents[0]!);
  const first = slot.querySelector("button")!;
  await act(async () => first.click());
  await render(parents[1]!);
  expect(slot.querySelectorAll("button")).toHaveLength(1);
  expect(slot.contains(first)).toBe(false);
  expect(first.disabled).toBe(true);
  const second = slot.querySelector("button")!;
  expect(second.textContent).toBe("Draft 0");
  await act(async () => {
    second.click();
  });
  await act(async () => {
    second.click();
  });
  await render(parents[2]!);
  expect(slot.querySelectorAll("button")).toHaveLength(1);
  expect(slot.textContent).toBe("Draft 0");
  expect(slot.contains(second)).toBe(false);
  await render(null);
  expect(slot.childElementCount).toBe(0);
  await render(parents[0]!);
  expect(slot.querySelector("button")).toBe(first);
  expect(slot.textContent).toBe("Draft 1");
  await render(parents[1]!);
  expect(slot.querySelector("button")).toBe(second);
  expect(slot.textContent).toBe("Draft 2");
});
