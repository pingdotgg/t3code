import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { AutoSettleDaysInput } from "./AutoSettleDaysInput";

function SettingsHarness() {
  const [days, setDays] = useState(14);
  return (
    <>
      <AutoSettleDaysInput value={days} onCommit={setDays} />
      <output aria-label="Saved inactivity days">{days}</output>
    </>
  );
}

describe("AutoSettleDaysInput", () => {
  it("keeps intermediate values local until editing is complete", async () => {
    await using screen = await render(<SettingsHarness />);
    const input = screen.getByRole("spinbutton");
    const saved = screen.getByLabelText("Saved inactivity days");
    await input.fill("1");
    await expect.element(saved).toHaveTextContent("14");
    await input.fill("30");
    await userEvent.keyboard("{Tab}");
    await expect.element(saved).toHaveTextContent("30");
    await expect.element(input).toHaveValue(30);
  });

  it("commits on Enter and cancels the draft on Escape", async () => {
    await using screen = await render(<SettingsHarness />);
    const input = screen.getByRole("spinbutton");
    const saved = screen.getByLabelText("Saved inactivity days");
    await input.fill("30");
    await userEvent.keyboard("{Enter}");
    await expect.element(saved).toHaveTextContent("30");
    await input.fill("1");
    await userEvent.keyboard("{Escape}{Tab}");
    await expect.element(input).toHaveValue(30);
    await expect.element(saved).toHaveTextContent("30");
  });

  it.each(["", "0", "91", "1.5"])("discards invalid draft %j on blur", async (draft) => {
    await using screen = await render(<SettingsHarness />);
    const input = screen.getByRole("spinbutton");
    await input.fill(draft);
    await userEvent.keyboard("{Tab}");
    await expect.element(input).toHaveValue(14);
    await expect.element(screen.getByLabelText("Saved inactivity days")).toHaveTextContent("14");
  });

  it("restores the saved value when a save fails, unless a newer edit replaced it", async () => {
    const failures: Array<() => void> = [];
    const onCommit = vi.fn((_: number, { onFailed }: { onFailed: () => void }) => {
      failures.push(onFailed);
    });
    await using screen = await render(<AutoSettleDaysInput value={14} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton");
    await input.fill("30");
    await userEvent.keyboard("{Enter}");
    await input.fill("45");
    await act(async () => failures[0]!());
    await expect.element(input).toHaveValue(45);
    await userEvent.keyboard("{Enter}");
    await userEvent.click(input);
    await userEvent.keyboard("{Tab}");
    await act(async () => failures[1]!());
    await expect.element(input).toHaveValue(14);
    await input.fill("45");
    await userEvent.keyboard("{Enter}");
    expect(onCommit.mock.calls.map(([days]) => days)).toEqual([30, 45, 45]);
  });

  it("saves a return to the original value while an earlier save is pending", async () => {
    const onCommit = vi.fn();
    await using screen = await render(<AutoSettleDaysInput value={14} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton");
    await input.fill("30");
    await userEvent.keyboard("{Enter}");
    await input.fill("14");
    await userEvent.keyboard("{Enter}");
    expect(onCommit.mock.calls.map(([days]) => days)).toEqual([30, 14]);
  });

  it("replaces a draft when another client changes the saved value", async () => {
    const onCommit = vi.fn();
    await using screen = await render(<AutoSettleDaysInput value={14} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton");
    await input.fill("1");
    await screen.rerender(<AutoSettleDaysInput value={45} onCommit={onCommit} />);
    await expect.element(input).toHaveValue(45);
    await userEvent.keyboard("{Tab}");
    expect(onCommit).not.toHaveBeenCalled();
  });
});
