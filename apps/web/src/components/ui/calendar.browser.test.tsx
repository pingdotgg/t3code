import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

vi.mock(import("~/i18n/I18nProvider"), () => ({ useFormattingLocale: () => "fr" }));

import { Calendar } from "./calendar";

it("labels the month and weekdays in the app language", async () => {
  await using screen = await render(
    <Calendar mode="single" defaultMonth={new Date(2026, 10, 1)} weekStartsOn={1} />,
    { router: false /* the calendar reads no route state */ },
  );

  await expect.element(screen.getByRole("grid", { name: "novembre 2026" })).toBeVisible();
  await expect.element(screen.getByText("novembre 2026")).toBeVisible();
  const weekdays = [...screen.container.querySelectorAll("thead th")].map((th) => th.textContent);
  expect(weekdays).toEqual(["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."]);
});
