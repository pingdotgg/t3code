import { expect, it } from "vite-plus/test";

import { act, render, type Screen } from "../../../test/render";
import { RedactedSensitiveText, redactedPlaceholder } from "./RedactedSensitiveText";

import "~/index.css";

const email = "developer@example.com";
const label = "Toggle account email visibility";

const sensitiveText = (
  <RedactedSensitiveText
    value={email}
    ariaLabel={label}
    revealTooltip="Reveal email"
    hideTooltip="Hide email"
  />
);

async function reveal(screen: Screen) {
  const toggle = screen.getByRole("button", { name: label }).element() as HTMLButtonElement;
  await act(() => toggle.click());
  for (const animation of toggle.getAnimations()) animation.finish();
  await expect.element(screen.getByRole("button", { name: label })).toHaveStyle({ filter: "none" });
  return toggle;
}

function pauseBlurMidway(toggle: HTMLButtonElement) {
  const blur = toggle
    .getAnimations()
    .find(
      (animation): animation is CSSTransition =>
        animation instanceof CSSTransition && animation.transitionProperty === "filter",
    );
  if (!blur) throw new Error("Expected a running filter transition");
  blur.pause();
  blur.currentTime = Number(blur.effect?.getComputedTiming().duration) / 2;
  return blur;
}

it("keeps the real text until the hide blur finishes", async () => {
  await using screen = await render(sensitiveText);
  const toggle = await reveal(screen);

  await act(() => toggle.click());
  const blur = pauseBlurMidway(toggle);
  expect(toggle.textContent).toBe(email);

  await act(() => blur.finish());
  await expect
    .element(screen.getByRole("button", { name: label }))
    .toHaveTextContent(redactedPlaceholder(email));
});

it("a reversed hide leaves the next hide intact, and a cancelled or suppressed blur still hides", async () => {
  await using screen = await render(sensitiveText);
  const toggle = await reveal(screen);

  await act(() => toggle.click());
  pauseBlurMidway(toggle);
  await act(() => toggle.click());
  await act(() => toggle.click());
  const blur = pauseBlurMidway(toggle);
  expect(toggle.textContent).toBe(email);

  await act(() => blur.cancel());
  await expect
    .element(screen.getByRole("button", { name: label }))
    .toHaveTextContent(redactedPlaceholder(email));

  await act(() => toggle.click());
  screen.container.classList.add("no-transitions");
  await act(() => toggle.click());
  await expect
    .element(screen.getByRole("button", { name: label }))
    .toHaveTextContent(redactedPlaceholder(email));
});
