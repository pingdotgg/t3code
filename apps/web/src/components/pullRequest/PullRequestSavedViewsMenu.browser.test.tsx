import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { PullRequestSavedViewsMenu } from "./PullRequestSavedViewsMenu";
import type { PullRequestListPreferences } from "./pullRequestListPreferences";
import { PULL_REQUEST_SAVED_VIEWS_KEY, type PullRequestSavedView } from "./pullRequestSavedViews";

const { toastAdd } = vi.hoisted(() => ({ toastAdd: vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager: { add: toastAdd } }));

let root: Root;
let container: HTMLDivElement;
const onApply = vi.fn();
const reviewing = {
  involvement: "reviewing",
  state: "open",
  q: "bug",
  draft: "hide",
  sort: "updated",
} as const satisfies PullRequestListPreferences;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  onApply.mockClear();
  toastAdd.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(preferences: PullRequestListPreferences = reviewing) {
  await act(() =>
    root.render(<PullRequestSavedViewsMenu preferences={preferences} onApply={onApply} />),
  );
}

async function openMenu() {
  await act(() =>
    container.querySelector<HTMLButtonElement>('[aria-label="Saved pull request views"]')!.click(),
  );
}

async function choose(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent === label,
  );
  expect(item, label).toBeDefined();
  await act(() => item!.click());
}

async function nameView(name: string) {
  const input = document.querySelector<HTMLInputElement>("input")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(() =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

function storedViews(): ReadonlyArray<PullRequestSavedView> {
  return JSON.parse(localStorage.getItem(PULL_REQUEST_SAVED_VIEWS_KEY) ?? "[]");
}

it("saves a named filter setup and restores it after remounting", async () => {
  await render();
  await openMenu();
  await choose("Save current view…");
  expect(document.querySelector("input")?.value).toBe("PRs Requesting My Review");
  await submit();
  expect(storedViews()).toEqual([
    { id: expect.any(String), name: "PRs Requesting My Review", preferences: reviewing },
  ]);

  await act(() => root.unmount());
  root = createRoot(container);
  await render({ involvement: "all", state: "merged", checks: "failing" });
  await openMenu();
  await choose("PRs Requesting My Review");
  expect(onApply).toHaveBeenCalledExactlyOnceWith(reviewing);
});

it("updates, renames, and deletes a view without affecting another saved view", async () => {
  localStorage.setItem(
    PULL_REQUEST_SAVED_VIEWS_KEY,
    JSON.stringify([
      { id: "reviewing", name: "Review queue", preferences: reviewing },
      { id: "authored", name: "My PRs", preferences: { involvement: "authored", state: "open" } },
    ]),
  );
  await render();
  await openMenu();
  await choose("Review queue");
  await render({ ...reviewing, checks: "passing" });
  await openMenu();
  await choose("Update saved view");
  expect(storedViews()[0]?.preferences.checks).toBe("passing");
  await openMenu();
  await choose("Rename view…");
  await nameView("My PRs");
  expect(document.body.textContent).toContain("A view with this name already exists.");
  await nameView("  Ready to review  ");
  await submit();
  expect(storedViews()[0]?.name).toBe("Ready to review");
  await openMenu();
  await choose("Delete view");
  expect(storedViews().map((view) => view.id)).toEqual(["authored"]);
});

it("keeps the dialog open and reports a failed storage write", async () => {
  await render();
  await openMenu();
  await choose("Save current view…");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota exceeded");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  await submit();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(storedViews()).toEqual([]);
  expect(toastAdd).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", title: "Could not save PR views" }),
  );
});

it("keeps the explicitly chosen view selected when two views have identical filters", async () => {
  localStorage.setItem(
    PULL_REQUEST_SAVED_VIEWS_KEY,
    JSON.stringify([
      { id: "first", name: "First queue", preferences: reviewing },
      { id: "second", name: "Second queue", preferences: reviewing },
    ]),
  );
  await render();
  await openMenu();
  await choose("Second queue");
  expect(container.textContent).toContain("Second queue");
  await openMenu();
  await choose("Delete view");
  expect(storedViews().map((view) => view.id)).toEqual(["first"]);
});

it("keeps the selected view as the update target when edits match another view", async () => {
  const other = {
    id: "other",
    name: "Other queue",
    preferences: { ...reviewing, checks: "passing" },
  } as const;
  localStorage.setItem(
    PULL_REQUEST_SAVED_VIEWS_KEY,
    JSON.stringify([{ id: "reviewing", name: "Review queue", preferences: reviewing }, other]),
  );
  await render();
  await openMenu();
  await choose("Review queue");
  await render(other.preferences);
  expect(container.textContent).toContain("Review queue*");
  await openMenu();
  await choose("Update saved view");
  expect(storedViews()).toEqual([
    { id: "reviewing", name: "Review queue", preferences: other.preferences },
    other,
  ]);
  await openMenu();
  await choose("Other queue");
  expect(container.textContent).toContain("Other queue");
});
