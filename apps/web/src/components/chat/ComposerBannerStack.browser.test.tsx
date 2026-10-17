import "../../index.css";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { ComposerBannerStack } from "./ComposerBannerStack";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const nextFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));

async function render(width: number, description: string) {
  container.style.width = `${width}px`;
  await act(async () =>
    root.render(
      <ComposerBannerStack
        items={[{ id: "usage", variant: "info", icon: null, title: "Usage limits", description }]}
      />,
    ),
  );
  await nextFrame();
}

const hasDetails = () => container.querySelector('[aria-label="Show notice details"]') !== null;

it("only offers notice details when the description cannot fit", async () => {
  await render(700, "OpenCode");
  expect(hasDetails()).toBe(false);

  await render(700, "OpenCode ".repeat(40));
  expect(hasDetails()).toBe(true);

  container.style.width = "4000px";
  await nextFrame();
  expect(hasDetails()).toBe(false);

  await render(4000, "OpenCode");
  expect(hasDetails()).toBe(false);

  // A narrow composer hides the description entirely, so details are the only way to read it.
  container.style.width = "300px";
  await nextFrame();
  expect(hasDetails()).toBe(true);
});

const titles = (scope: ParentNode) =>
  Array.from(
    scope.querySelectorAll('[data-slot="composer-banner-content"] > span:first-child'),
    (title) => title.textContent,
  );

it("keeps urgent, warning and error notices out of the collapsed stack behind activity", async () => {
  await act(async () =>
    root.render(
      <ComposerBannerStack
        items={[
          {
            id: "limit",
            variant: "warning",
            priority: "urgent",
            icon: null,
            title: "Usage limit reached",
          },
          { id: "usage", variant: "info", priority: "notice", icon: null, title: "Usage limits" },
          { id: "offline", variant: "warning", icon: null, title: "Server is reconnecting" },
          { id: "clone", variant: "error", icon: null, title: "Failed to clone repo" },
          {
            id: "work",
            variant: "default",
            priority: "activity",
            icon: null,
            title: "Waiting on 2 subagents",
          },
        ]}
      />,
    ),
  );
  // Order is unchanged: activity stays attached, with the notices above it.
  expect(titles(container)).toEqual([
    "Usage limit reached",
    "Server is reconnecting",
    "Failed to clone repo",
    "Usage limits",
    "Waiting on 2 subagents",
  ]);
  // Only the ordinary notice waits behind the hover-to-expand peek.
  expect(titles(container.querySelector('[aria-label="Other notices"]')!)).toEqual([
    "Usage limits",
  ]);
});
