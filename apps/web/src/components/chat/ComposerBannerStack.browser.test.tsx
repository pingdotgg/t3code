import "../../index.css";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { Button, InlineButton } from "../ui/button";

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

it.each([320, 800])(
  "keeps long background-work links reachable beside Stop in a %ipx composer",
  async (width) => {
    await page.viewport(width + 32, 800);
    container.style.width = `${width}px`;
    const openThread = vi.fn();
    const label = "Review the background task layout and child-thread navigation ".repeat(6);
    await act(async () =>
      root.render(
        <ComposerBannerStack
          items={[
            {
              id: "background-work",
              variant: "default",
              priority: "activity",
              icon: null,
              title: "12 background tasks",
              descriptionPlacement: "below",
              description: Array.from({ length: 12 }, (_, index) => (
                <span key={index}>
                  {index > 0 ? " " : null}
                  <InlineButton
                    tone="muted"
                    aria-label={`Open subagent ${index + 1}`}
                    onClick={() => openThread(index + 1)}
                  >
                    {label}
                  </InlineButton>
                  {index < 11 ? "," : null}
                </span>
              )),
              actions: (
                <Button size="xs" variant="ghost">
                  Stop
                </Button>
              ),
            },
          ]}
        />,
      ),
    );
    await nextFrame();

    const firstLink = page.getByRole("button", { name: "Open subagent 1", exact: true });
    const lastLink = page.getByRole("button", { name: "Open subagent 12", exact: true });
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    expect(firstLink.element().getBoundingClientRect().height).toBeGreaterThan(
      Number.parseFloat(getComputedStyle(firstLink.element()).lineHeight) * 2,
    );
    const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    expect(viewport).not.toBeNull();
    expect(viewport.clientHeight).toBeGreaterThan(0);
    expect(viewport.clientHeight).toBeLessThanOrEqual(window.innerHeight / 2);
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);

    const scrollBounds = viewport.getBoundingClientRect();
    const stopBounds = stop.element().getBoundingClientRect();
    expect(stopBounds.top).toBe(
      page.getByText("12 background tasks", { exact: true }).element().getBoundingClientRect().top,
    );
    expect(scrollBounds.right).toBeLessThanOrEqual(stopBounds.left);
    expect(stopBounds.right).toBeLessThanOrEqual(container.getBoundingClientRect().right);
    expect(stopBounds.bottom).toBeLessThanOrEqual(scrollBounds.bottom);
    expect(lastLink.element().getBoundingClientRect().top).toBeGreaterThan(scrollBounds.bottom);
    await firstLink.click();
    expect(openThread).toHaveBeenLastCalledWith(1);

    viewport.scrollTop = viewport.scrollHeight;
    await nextFrame();
    expect(viewport.scrollTop).toBeGreaterThan(0);
    const lastBounds = lastLink.element().getBoundingClientRect();
    expect(lastBounds.top).toBeGreaterThanOrEqual(scrollBounds.top);
    expect(lastBounds.bottom).toBeLessThanOrEqual(scrollBounds.bottom + 1);
    expect(stop.element().getBoundingClientRect().top).toBe(stopBounds.top);
    for (const control of [lastLink.element(), stop.element()]) {
      const bounds = control.getBoundingClientRect();
      expect(
        control.contains(
          document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
        ),
      ).toBe(true);
    }
    await lastLink.click();
    expect(openThread).toHaveBeenLastCalledWith(12);
  },
);

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
