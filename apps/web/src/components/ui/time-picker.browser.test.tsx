import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { TimePicker } from "./time-picker";

import "~/index.css";

function ControlledTimePicker(props: { initial?: string; hour12?: boolean }) {
  const [value, setValue] = useState(props.initial ?? "01:00");
  return (
    <div className="p-4">
      <TimePicker value={value} onValueChange={setValue} hour12={props.hour12 ?? true} size="sm" />
      <output data-testid="value">{value}</output>
    </div>
  );
}

describe("TimePicker", () => {
  it("supports keyboard typing and arrow stepping in 12-hour mode", async () => {
    await using screen = await render(<ControlledTimePicker initial="01:00" hour12 />);

    const hour = screen.getByRole("spinbutton", { name: "Hour" });
    await hour.click();
    await userEvent.keyboard("10");

    await expect.element(screen.getByTestId("value")).toHaveTextContent("10:00");

    // Focus auto-advanced to minute; type 35
    await userEvent.keyboard("35");
    await expect.element(screen.getByTestId("value")).toHaveTextContent("10:35");

    // Focus auto-advanced to AM/PM; press "p" for pm
    await userEvent.keyboard("p");
    await expect.element(screen.getByTestId("value")).toHaveTextContent("22:35");
  });

  it("opens the popover, selects a time, and reverts on Escape", async () => {
    await using screen = await render(<ControlledTimePicker initial="01:00" hour12 />);

    await screen.getByRole("button", { name: "Choose time" }).click();
    const hourList = page.getByRole("listbox", { name: "Hour" });
    await expect.element(hourList).toBeVisible();

    await hourList.getByRole("option", { name: "06" }).click();
    await page
      .getByRole("listbox", { name: "AM or PM" })
      .getByRole("option", { name: "pm" })
      .click();
    await expect.element(screen.getByTestId("value")).toHaveTextContent("18:00");

    // Escape reverts to the value when the popover opened
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByTestId("value")).toHaveTextContent("01:00");
  });

  it("hides the AM/PM segment and column in 24-hour mode", async () => {
    await using screen = await render(<ControlledTimePicker initial="18:30" hour12={false} />);

    expect(screen.container.querySelector('[aria-label="AM or PM"]')).toBeNull();
    await screen.getByRole("button", { name: "Choose time" }).click();
    await expect
      .element(page.getByRole("listbox", { name: "Hour" }).getByRole("option", { name: "18" }))
      .toBeVisible();
  });
});
