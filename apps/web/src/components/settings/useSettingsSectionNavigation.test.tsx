// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useSettingsSectionNavigation } from "./useSettingsSectionNavigation";

let root: Root;
let container: HTMLDivElement;
const navigate = vi.fn();
function Sections({ current = "General", projects = true, searching = false }) {
  const navigation = useSettingsSectionNavigation();
  return searching ? (
    <input aria-label="Search settings" />
  ) : (
    <ul {...navigation} role="tree" aria-label="Settings sections">
      {["General", "Appearance", ...(projects ? ["Projects"] : []), "Keybindings"].map((name) => (
        <li key={name} role="presentation">
          <button
            role="treeitem"
            data-settings-section={name}
            aria-selected={name === current}
            aria-current={name === current ? "page" : undefined}
            onClick={() => navigate(name)}
          >
            {name}
          </button>
        </li>
      ))}
    </ul>
  );
}
const section = (name: string) =>
  container.querySelector<HTMLButtonElement>(`[data-settings-section="${name}"]`)!;
function press(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  document.activeElement!.dispatchEvent(event);
  return event;
}
beforeEach(async () => {
  navigate.mockClear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Sections />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it("moves focus without opening sections and keeps one Tab entry", () => {
  section("General").focus();
  press("ArrowDown");
  expect(document.activeElement).toBe(section("Appearance"));
  expect(navigate).not.toHaveBeenCalled();
  expect(container.querySelectorAll("button[tabindex='0']")).toHaveLength(1);
  expect(section("General").tabIndex).toBe(-1);
  // Native button activation remains available; the roving list doesn't intercept Enter.
  expect(press("Enter").defaultPrevented).toBe(false);
  section("Appearance").click();
  expect(navigate).toHaveBeenCalledWith("Appearance");
  press("End");
  expect(document.activeElement).toBe(section("Keybindings"));
  press("ArrowDown");
  expect(document.activeElement).toBe(section("Keybindings"));
  press("ArrowUp");
  expect(document.activeElement).toBe(section("Projects"));
  press("Home");
  press("ArrowUp");
  expect(document.activeElement).toBe(section("General"));
});

it("preserves focused identity through rerenders and follows page changes when outside the list", async () => {
  section("Projects").focus();
  await act(async () => root.render(<Sections current="Appearance" />));
  expect(document.activeElement).toBe(section("Projects"));
  expect(section("Projects").tabIndex).toBe(0);
  section("Projects").blur();
  await act(async () => root.render(<Sections current="Keybindings" />));
  expect(section("Keybindings").tabIndex).toBe(0);
  expect(container.querySelectorAll("button[tabindex='0']")).toHaveLength(1);
});

it("recovers a Tab entry when scope removes a section or search replaces the list", async () => {
  section("Projects").focus();
  await act(async () => root.render(<Sections projects={false} />));
  expect(section("General").tabIndex).toBe(0);
  await act(async () => root.render(<Sections searching />));
  const input = container.querySelector("input")!;
  input.focus();
  input.value = "mode";
  input.setSelectionRange(2, 2);
  expect(press("Home").defaultPrevented).toBe(false);
  expect(press("ArrowDown").defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(input);
  await act(async () => root.render(<Sections current="Appearance" />));
  expect(section("Appearance").tabIndex).toBe(0);
  expect(container.querySelectorAll("button[tabindex='0']")).toHaveLength(1);
});

it("preserves modified navigation shortcuts", () => {
  section("Appearance").focus();
  expect(press("ArrowDown", { altKey: true }).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(section("Appearance"));
});

it("keeps focus on root leaves for Left and Right without opening a section", () => {
  section("Appearance").focus();
  expect(press("ArrowLeft").defaultPrevented).toBe(true);
  expect(press("ArrowRight").defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(section("Appearance"));
  expect(navigate).not.toHaveBeenCalled();
});
