import "../../index.css";

import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { ComposerBannerStack } from "./ComposerBannerStack";

function sized(width: number) {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  return container;
}

const nextFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));

const usage = (description: string) => (
  <ComposerBannerStack
    items={[{ id: "usage", variant: "info", icon: null, title: "Usage limits", description }]}
  />
);

it("only offers notice details when the description cannot fit", async () => {
  await using screen = await render(usage("OpenCode"), { container: sized(700) });
  const { container } = screen;
  const hasDetails = () => container.querySelector('[aria-label="Show notice details"]') !== null;
  await nextFrame();
  expect(hasDetails()).toBe(false);

  await screen.rerender(usage("OpenCode ".repeat(40)));
  await nextFrame();
  expect(hasDetails()).toBe(true);

  container.style.width = "4000px";
  await nextFrame();
  expect(hasDetails()).toBe(false);

  await screen.rerender(usage("OpenCode"));
  await nextFrame();
  expect(hasDetails()).toBe(false);

  // A narrow composer hides the description entirely, so details are the only way to read it.
  container.style.width = "300px";
  await nextFrame();
  expect(hasDetails()).toBe(true);
});

it("keeps only the usage limit attached while an active goal waits in the collapsible stack", async () => {
  await using screen = await render(
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
  );
  const { container } = screen;

  const visibleBanners = () =>
    Array.from(container.querySelectorAll('[data-slot="composer-banner"]')).filter((banner) =>
      banner.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
    );
  const limit = page.getByText("Usage limit reached", { exact: true });
  const goal = page.getByText("Goal active", { exact: true });

  // A retained pointer can expand the stack as it mounts; start outside the hover target.
  await userEvent.hover(limit);
  await expect.poll(visibleBanners).toHaveLength(1);
  await expect.element(limit).toBeVisible();
  await expect.element(goal).not.toBeVisible();
  expect(container.querySelector('[data-slot="composer-banner-attachment"]')?.textContent).toBe(
    "Usage limit reached",
  );

  const peek = page.getByRole("button", { name: "Show other notices" });
  // Hover opens the stack and hides the peek before a pointer click can finish.
  await act(() => peek.element().focus());
  await userEvent.keyboard("{Enter}");
  await expect.element(goal).toBeVisible();
  await expect.element(limit).toBeVisible();
  await expect.poll(visibleBanners).toHaveLength(2);

  await userEvent.keyboard("{Escape}");
  await expect.element(goal).not.toBeVisible();
  await expect.element(limit).toBeVisible();
  expect(visibleBanners()).toHaveLength(1);

  await userEvent.hover(peek);
  await expect.element(goal).toBeVisible();
  await expect.element(limit).toBeVisible();
  await expect.poll(visibleBanners).toHaveLength(2);
});

it("reveals the full running command only while its title is clipped", async () => {
  const command =
    "Running: /usr/bin/zsh -lc 'sleep 600 > /tmp/t3-background-command-with-a-long-log-filename-for-truncation.log 2>&1'";
  await using screen = await render(
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
    { container: sized(240) },
  );

  const details = page.getByRole("button", { name: "Show title details", exact: true });
  await expect.element(details).toBeVisible();
  await userEvent.hover(details);
  const popup = page.getByRole("dialog", { name: "Notice details", exact: true });
  await expect.element(popup).toBeVisible();
  await expect.element(popup).toHaveTextContent(command);

  screen.container.style.width = "4000px";
  await expect.element(details).not.toBeInTheDocument();
  await expect.element(popup).not.toBeInTheDocument();
});
