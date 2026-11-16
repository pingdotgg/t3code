import { DirectionProvider } from "@base-ui/react/direction-provider";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { Switch } from "./switch";

it.each([
  { direction: "ltr", size: "default" },
  { direction: "rtl", size: "default" },
  { direction: "ltr", size: "sm" },
  { direction: "rtl", size: "sm" },
] as const)(
  "keeps $direction $size switch states inside their tracks",
  async ({ direction, size }) => {
    const layout = (mixedChecked = false) => (
      <DirectionProvider direction={direction}>
        <div dir={direction}>
          <Switch aria-label="Notifications" size={size} />
          <Switch aria-label="Mixed settings" size={size} mixed checked={mixedChecked} />
        </div>
      </DirectionProvider>
    );
    await using screen = await render(layout());
    const track = screen.container.querySelector<HTMLElement>('[aria-label="Notifications"]')!;
    const thumb = track.querySelector<HTMLElement>('[data-slot="switch-thumb"]')!;
    const assertPosition = (checked: boolean) => {
      const bounds = track.getBoundingClientRect();
      const knob = thumb.getBoundingClientRect();
      const atRight = checked !== (direction === "rtl");
      const target = atRight ? bounds.right - 2 - knob.width : bounds.left + 2;
      expect(Math.abs(knob.left - target)).toBeLessThan(0.5);
      expect(knob.left).toBeGreaterThanOrEqual(bounds.left);
      expect(knob.right).toBeLessThanOrEqual(bounds.right);
    };

    await vi.waitFor(() => assertPosition(false));
    await screen.getByRole("switch", { name: "Notifications" }).click();
    await expect.element(screen.getByRole("switch", { name: "Notifications" })).toBeChecked();
    await vi.waitFor(() => assertPosition(true));
    await screen.getByRole("switch", { name: "Notifications" }).click();
    await vi.waitFor(() => assertPosition(false));

    for (const checked of [false, true]) {
      await screen.rerender(layout(checked));
      const mixed = screen.container.querySelector<HTMLElement>('[aria-label="Mixed settings"]')!;
      await expect
        .element(screen.getByRole("switch", { name: "Mixed settings" }))
        .toHaveAttribute("aria-checked", "mixed");
      await vi.waitFor(() => {
        const bounds = mixed.getBoundingClientRect();
        const knob = mixed.querySelector('[data-slot="switch-thumb"]')!.getBoundingClientRect();
        expect(
          Math.abs(knob.left + knob.width / 2 - (bounds.left + bounds.width / 2)),
        ).toBeLessThan(0.5);
      });
    }
  },
);
