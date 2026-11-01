import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { RedactedSensitiveText } from "./RedactedSensitiveText";

import "../../index.css";

const email = "developer@example.com";
const label = "Toggle account email visibility";
const sensitiveText = () => (
  <RedactedSensitiveText
    value={email}
    ariaLabel={label}
    revealTooltip="Reveal email"
    hideTooltip="Hide email"
  />
);

function pauseBlur(toggle: HTMLButtonElement) {
  const transition = toggle
    .getAnimations()
    .find(
      (animation) =>
        animation instanceof CSSTransition && animation.transitionProperty === "filter",
    );
  expect(transition).toBeDefined();
  transition!.pause();
  transition!.currentTime = Number(transition!.effect!.getComputedTiming().duration) / 2;
  return transition!;
}

it("blurs the revealed email before replacing it with the placeholder", async () => {
  await using screen = await render(sensitiveText());
  const toggle = screen.getByRole("button", { name: label }).element() as HTMLButtonElement;
  const placeholder = toggle.textContent;
  const hiddenFilter = getComputedStyle(toggle).filter;
  await screen.getByRole("button", { name: label }).click();
  await expect.element(screen.getByRole("button", { name: label })).toHaveStyle({ filter: "none" });
  expect(toggle.textContent).toBe(email);
  const revealedFilter = getComputedStyle(toggle).filter;

  await act(() => toggle.click());
  const blur = pauseBlur(toggle);
  expect(getComputedStyle(toggle).filter).not.toBe(revealedFilter);
  expect(getComputedStyle(toggle).filter).not.toBe(hiddenFilter);
  expect(toggle.textContent).toBe(email);

  await act(() => blur.finish());
  await expect.element(screen.getByRole("button", { name: label })).toHaveTextContent(placeholder!);
  expect(getComputedStyle(toggle).filter).toBe(hiddenFilter);
});

it("keeps a later hide intact after revealing during a theme-interrupted hide", async () => {
  await using screen = await render(sensitiveText());
  const toggle = screen.getByRole("button", { name: label }).element() as HTMLButtonElement;
  const placeholder = toggle.textContent;
  const hiddenFilter = getComputedStyle(toggle).filter;
  await screen.getByRole("button", { name: label }).click();
  await expect.element(screen.getByRole("button", { name: label })).toHaveStyle({ filter: "none" });
  using _timers = fakeTimers();

  screen.container.classList.add("no-transitions");
  await act(() => toggle.click());
  expect(getComputedStyle(toggle).filter).toBe(hiddenFilter);
  await act(() => vi.advanceTimersByTime(300));
  await act(() => toggle.click());
  expect(toggle.textContent).toBe(email);
  expect(getComputedStyle(toggle).filter).not.toBe(hiddenFilter);
  await act(() => vi.advanceTimersByTime(50));
  screen.container.classList.remove("no-transitions");
  expect(getComputedStyle(toggle).filter).not.toBe(hiddenFilter);

  await act(() => toggle.click());
  const blur = pauseBlur(toggle);
  await act(() => vi.advanceTimersByTime(50));
  expect(getComputedStyle(toggle).filter).not.toBe(hiddenFilter);
  expect(toggle.textContent).toBe(email);

  blur.cancel();
  expect(getComputedStyle(toggle).filter).toBe(hiddenFilter);
  await act(() => vi.advanceTimersByTime(1_000));
  expect(toggle.textContent).toBe(placeholder);
});
