import "~/index.css";

import type { TimestampFormat } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { fakeTimers, render } from "../../test/render";
import { CustomSnoozeDialogHost, requestCustomSnooze } from "./CustomSnoozeDialog";

const settings = vi.hoisted(() => ({ timestampFormat: "24-hour" as TimestampFormat }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (selector: (value: typeof settings) => unknown) => selector(settings),
}));

function setup(timestampFormat: TimestampFormat = "24-hour") {
  settings.timestampFormat = timestampFormat;
  const timers = fakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2030, 0, 2, 14, 30));
  return timers;
}

function TestSnooze({ onResult }: { onResult: (result: unknown) => void }) {
  return (
    <>
      <button onClick={() => void requestCustomSnooze().then(onResult)}>Custom snooze</button>
      <CustomSnoozeDialogHost />
    </>
  );
}

it.each(["17:30", "23:59"])("accepts and retains visible 24-hour entry %s", async (time) => {
  using _setup = setup();
  const onResult = vi.fn();
  await using screen = await render(<TestSnooze onResult={onResult} />);
  await userEvent.click(screen.getByRole("button", { name: "Custom snooze" }));

  const field = page.getByRole("textbox", { name: "Time", exact: true });
  await expect.element(field).toHaveValue("15:30");
  await userEvent.fill(field, time);
  await expect.element(field).toHaveValue(time);
  await userEvent.click(page.getByRole("button", { name: "Snooze", exact: true }));

  const [hours, minutes] = time.split(":").map(Number);
  expect(onResult).toHaveBeenCalledWith({
    snoozedUntil: new Date(2030, 0, 2, hours, minutes).toISOString(),
  });
});

it("rejects invalid and past times, then accepts midnight on a future date", async () => {
  using _setup = setup();
  const onResult = vi.fn();
  await using screen = await render(<TestSnooze onResult={onResult} />);
  await userEvent.click(screen.getByRole("button", { name: "Custom snooze" }));

  const field = page.getByRole("textbox", { name: "Time", exact: true });
  for (const time of ["", "24:00", "17:60", "5:30", "5:30 PM"]) {
    await userEvent.fill(field, time);
    await userEvent.click(page.getByRole("button", { name: "Snooze", exact: true }));
    expect(onResult).not.toHaveBeenCalled();
    expect((field.element() as HTMLInputElement).checkValidity()).toBe(false);
  }

  await userEvent.fill(field, "00:00");
  await userEvent.click(page.getByRole("button", { name: "Snooze", exact: true }));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Choose a valid date and time in the future.");
  expect(onResult).not.toHaveBeenCalled();

  await userEvent.click(page.getByRole("button", { name: "Date", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Thursday, January 3rd, 2030" }));
  await userEvent.click(page.getByRole("button", { name: "Snooze", exact: true }));
  expect(onResult).toHaveBeenCalledWith({
    snoozedUntil: new Date(2030, 0, 3, 0, 0).toISOString(),
  });
});

it.each(["12-hour", "locale"] as const)("keeps native time entry for %s", async (format) => {
  using _setup = setup(format);
  const onResult = vi.fn();
  await using screen = await render(<TestSnooze onResult={onResult} />);
  await userEvent.click(screen.getByRole("button", { name: "Custom snooze" }));
  const field = page.getByLabelText("Time", { exact: true });
  await expect.element(field).toHaveAttribute("type", "time");
  await userEvent.fill(field, "17:30");
  await userEvent.click(page.getByRole("button", { name: "Snooze", exact: true }));
  expect(onResult).toHaveBeenCalledWith({
    snoozedUntil: new Date(2030, 0, 2, 17, 30).toISOString(),
  });
});
