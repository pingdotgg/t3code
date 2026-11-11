import { expect, it } from "vite-plus/test";
import {
  dismissContextMenu,
  isContextMenuOpen,
  showContextMenuFallback,
} from "./contextMenuFallback";

const items = [
  { id: "heading", label: "Thread actions", header: true },
  { id: "disabled", label: "Unavailable", disabled: true },
  { id: "rename", label: "Rename" },
  { id: "pin", label: "Pinned", checked: true, separatorBefore: true },
  {
    id: "copy",
    label: "Copy",
    children: [
      { id: "copy-unavailable", label: "Unavailable copy", disabled: true },
      { id: "path", label: "Path" },
      { id: "branch", label: "Branch" },
    ],
  },
];

function setup() {
  const origin = document.createElement("button");
  origin.textContent = "Selected thread";
  document.body.append(origin);
  origin.focus();
  return {
    origin,
    [Symbol.dispose]() {
      dismissContextMenu();
      origin.remove();
    },
  };
}

function press(key: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(event);
  return event;
}

const label = () => document.activeElement?.textContent;

it("starts a keyboard-opened menu on its first action and wraps through enabled actions", () => {
  using _fixture = setup();
  void showContextMenuFallback(items);
  expect(label()).toBe("Rename");
  press("ArrowUp");
  expect(label()).toBe("Copy");
  press("ArrowDown");
  expect(label()).toBe("Rename");
  press("End");
  expect(label()).toBe("Copy");
  press("Home");
  expect(label()).toBe("Rename");
});

it("opens and cancels one submenu level at a time, then returns to the thread", async () => {
  using fixture = setup();
  const result = showContextMenuFallback(items);
  press("End");
  const parent = document.activeElement;
  press("ArrowRight");
  expect(label()).toBe("Path");
  press("ArrowLeft");
  expect(document.activeElement).toBe(parent);
  press("Enter");
  expect(label()).toBe("Path");
  press("Escape");
  expect(document.activeElement).toBe(parent);
  expect(isContextMenuOpen()).toBe(true);
  press("Escape");
  expect(document.activeElement).toBe(fixture.origin);
  await expect(result).resolves.toBeNull();
});

it("activates the focused action with Space or Enter", async () => {
  using _fixture = setup();
  const first = showContextMenuFallback(items);
  press(" ");
  await expect(first).resolves.toBe("rename");
  const second = showContextMenuFallback(items);
  press("Enter");
  await expect(second).resolves.toBe("rename");
});

it("closes on Tab and returns focus to the opener so Tab continues from there", async () => {
  using fixture = setup();
  const result = showContextMenuFallback(items);
  expect(press("Tab").defaultPrevented).toBe(false);
  await expect(result).resolves.toBeNull();
  expect(document.activeElement).toBe(fixture.origin);
});

it("closes without taking focus back when focus moves elsewhere", async () => {
  using _fixture = setup();
  const result = showContextMenuFallback(items);
  const destination = document.createElement("button");
  document.body.append(destination);
  using _destination = { [Symbol.dispose]: () => destination.remove() };
  destination.focus();
  await expect(result).resolves.toBeNull();
  expect(document.activeElement).toBe(destination);
});
