import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

const locale = vi.hoisted(() => ({ current: "fr" }));
vi.mock(import("~/i18n/I18nProvider"), () => ({ useFormattingLocale: () => locale.current }));

import { Calendar } from "./calendar";

function renderNovember(formattingLocale: string) {
  locale.current = formattingLocale;
  const html = renderToStaticMarkup(
    <Calendar mode="single" defaultMonth={new Date(2026, 10, 1)} weekStartsOn={1} />,
  );
  return {
    grid: html.match(/<table[^>]*aria-label="([^"]*)"/)?.[1],
    caption: html.match(/role="status"[^>]*>([^<]*)</)?.[1],
    weekdays: [...html.matchAll(/<th [^>]*>([^<]*)<\/th>/g)].map((match) => match[1]),
  };
}

it("labels the month and weekdays in the app language", () => {
  expect(renderNovember("fr")).toEqual({
    grid: "novembre 2026",
    caption: "novembre 2026",
    weekdays: ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."],
  });
});

it("keeps two-letter English weekdays", () => {
  expect(renderNovember("en-US").weekdays).toEqual(["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]);
});

it("names the grid's Gregorian month under a non-Gregorian host locale", () => {
  const { grid, caption } = renderNovember("fa-IR");
  expect(grid).toBe("نوامبر ۲۰۲۶");
  expect(caption).toBe("نوامبر ۲۰۲۶");
});
