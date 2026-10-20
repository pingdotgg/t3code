import "../../index.css";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { Button } from "../ui/button";

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

it("keeps only the usage limit attached while an active goal waits in the collapsible stack", async () => {
  await act(async () =>
    root.render(
      <ComposerBannerStack
        items={[
          {
            id: "goal",
            variant: "default",
            priority: "activity",
            icon: null,
            title: "Goal active",
            description: "Finish the banner fix",
          },
          {
            id: "limit",
            variant: "default",
            priority: "urgent",
            icon: null,
            title: "Usage limit reached",
          },
        ]}
      />,
    ),
  );

  const visibleBanners = () =>
    Array.from(container.querySelectorAll('[data-slot="composer-banner"]')).filter((banner) =>
      banner.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
    );
  const limit = page.getByText("Usage limit reached", { exact: true });
  const goal = page.getByText("Goal active", { exact: true });

  expect(visibleBanners()).toHaveLength(1);
  await expect.element(limit).toBeVisible();
  await expect.element(goal).not.toBeVisible();
  expect(container.querySelector('[data-slot="composer-banner-attachment"]')?.textContent).toBe(
    "Usage limit reached",
  );

  await act(async () => page.getByRole("button", { name: "Show other notices" }).click());
  await expect.element(goal).toBeVisible();
  await expect.element(limit).toBeVisible();
  await expect.poll(visibleBanners).toHaveLength(2);

  await act(async () => userEvent.keyboard("{Escape}"));
  await expect.element(goal).not.toBeVisible();
  await expect.element(limit).toBeVisible();
  expect(visibleBanners()).toHaveLength(1);
});

it("reveals the full running command only while its title is clipped", async () => {
  const command =
    "Running: /usr/bin/zsh -lc 'sleep 600 > /tmp/t3-background-command-with-a-long-log-filename-for-truncation.log 2>&1'";
  container.style.width = "240px";
  await act(async () =>
    root.render(
      <ComposerBannerStack
        items={[
          {
            id: "background-work",
            variant: "default",
            priority: "activity",
            icon: null,
            title: command,
          },
        ]}
      />,
    ),
  );

  const details = page.getByRole("button", { name: "Show title details", exact: true });
  await expect.element(details).toBeVisible();
  await userEvent.hover(details);
  const popup = page.getByRole("dialog", { name: "Notice details", exact: true });
  await expect.element(popup).toBeVisible();
  await expect.element(popup).toHaveTextContent(command);

  container.style.width = "4000px";
  await expect.element(details).not.toBeInTheDocument();
  await expect.element(popup).not.toBeInTheDocument();
});

// Narrow viewports use larger touch-sized buttons, so check both breakpoints.
it.each([480, 1000])(
  "lines up the details buttons of stacked notices whose actions differ in width at %ipx",
  async (viewportWidth) => {
    await page.viewport(viewportWidth, 600);
    container.style.width = `${viewportWidth - 32}px`;
    const long = "Stress test the build pipeline end to end and report every failure ".repeat(3);
    await act(async () =>
      root.render(
        <ComposerBannerStack
          items={[
            {
              id: "goal",
              variant: "default",
              priority: "activity",
              icon: null,
              title: "Goal set",
              description: long,
              actions: <Button size="xs">Clear</Button>,
            },
            {
              id: "background-work",
              variant: "default",
              priority: "activity",
              icon: null,
              title: `Waiting on subagent ${long}`,
              actions: <Button size="xs">Stop</Button>,
            },
          ]}
        />,
      ),
    );
    // The pointer left over from the previous case may already have expanded the stack.
    await act(async () =>
      container.querySelector<HTMLElement>('[data-slot="composer-banner-peek"]')?.click(),
    );
    await nextFrame();

    const left = (label: string) =>
      page.getByRole("button", { name: label }).element().getBoundingClientRect().left;
    expect(left("Show title details")).toBe(left("Show notice details"));
  },
);
