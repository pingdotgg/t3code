import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const locale = vi.hoisted(() => ({ current: "fr" }));
vi.mock(import("~/i18n/I18nProvider"), () => ({ useFormattingLocale: () => locale.current }));

import { Calendar } from "./calendar";

async function renderNovember(formattingLocale: string) {
  locale.current = formattingLocale;
  return render(<Calendar mode="single" defaultMonth={new Date(2026, 10, 1)} weekStartsOn={1} />, {
    router: false /* the calendar reads no route state */,
  });
}

const weekdayHeaders = (container: HTMLElement) =>
  [...container.querySelectorAll("thead th")].map((th) => th.textContent);

it("labels the month and weekdays in the app language", async () => {
  await using screen = await renderNovember("fr");

  await expect.element(screen.getByRole("grid", { name: "novembre 2026" })).toBeVisible();
  await expect.element(screen.getByText("novembre 2026")).toBeVisible();
  expect(weekdayHeaders(screen.container)).toEqual([
    "lun.",
    "mar.",
    "mer.",
    "jeu.",
    "ven.",
    "sam.",
    "dim.",
  ]);
});

it("keeps two-letter English weekdays", async () => {
  await using screen = await renderNovember("en-US");

  await expect.element(screen.getByText("November 2026")).toBeVisible();
  expect(weekdayHeaders(screen.container)).toEqual(["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]);
});
