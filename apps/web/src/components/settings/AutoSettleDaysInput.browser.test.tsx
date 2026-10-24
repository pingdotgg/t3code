import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { AutoSettleDaysInput } from "./AutoSettleDaysInput";

function pendingSave() {
  let resolve!: (saved: boolean) => void;
  const promise = new Promise<boolean>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function SettingsHarness() {
  const [days, setDays] = useState(14);
  return (
    <>
      <AutoSettleDaysInput
        value={days}
        onCommit={async (next) => {
          setDays(next);
          return true;
        }}
      />
      <output aria-label="Saved inactivity days">{days}</output>
      <button>Done</button>
    </>
  );
}

describe("Auto-settle inactivity days", () => {
  it("restores the saved value when the settings plan is unavailable", async () => {
    await using screen = await render(
      <AutoSettleDaysInput value={14} onCommit={async () => false} />,
    );
    const input = screen.getByRole("spinbutton");
    await input.fill("30");
    await userEvent.keyboard("{Enter}");
    await expect.element(input).toHaveValue(14);
  });

  it.each([false, true])("keeps pending edits and handles save outcome %s", async (saved) => {
    const result = pendingSave();
    await using screen = await render(
      <AutoSettleDaysInput value={14} onCommit={() => result.promise} />,
    );
    const input = screen.getByRole("spinbutton");
    await input.fill("30");
    await userEvent.keyboard("{Enter}");
    await expect.element(input).toHaveValue(30);
    await act(async () => {
      result.resolve(saved);
    });
    await expect.element(input).toHaveValue(saved ? 30 : 14);
  });

  it("does not discard a newer edit when an earlier save fails", async () => {
    const result = pendingSave();
    await using screen = await render(
      <AutoSettleDaysInput value={14} onCommit={() => result.promise} />,
    );
    const input = screen.getByRole("spinbutton");
    await input.fill("30");
    await userEvent.keyboard("{Enter}");
    await input.fill("45");
    await act(async () => {
      result.resolve(false);
    });
    await expect.element(input).toHaveValue(45);
  });

  it("does not restore stale settings when another client updates a pending save", async () => {
    const result = pendingSave();
    const onCommit = () => result.promise;
    await using screen = await render(<AutoSettleDaysInput value={14} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton");
    await input.fill("30");
    await userEvent.keyboard("{Enter}");
    await screen.rerender(<AutoSettleDaysInput value={60} onCommit={onCommit} />);
    await act(async () => {
      result.resolve(false);
    });
    await expect.element(input).toHaveValue(60);
  });

  it("keeps intermediate values local until editing is complete", async () => {
    await using screen = await render(<SettingsHarness />);
    const input = screen.getByRole("spinbutton");
    await input.fill("1");
    await expect.element(screen.getByLabelText("Saved inactivity days")).toHaveTextContent("14");
    await input.fill("30");
    await userEvent.keyboard("{Tab}");
    await expect.element(screen.getByLabelText("Saved inactivity days")).toHaveTextContent("30");
    await expect.element(input).toHaveValue(30);
  });

  it("commits on Enter and cancels the draft on Escape", async () => {
    await using screen = await render(<SettingsHarness />);
    const input = screen.getByRole("spinbutton");
    await input.fill("30");
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByLabelText("Saved inactivity days")).toHaveTextContent("30");
    await input.fill("1");
    await userEvent.keyboard("{Escape}{Tab}");
    await expect.element(input).toHaveValue(30);
    await expect.element(screen.getByLabelText("Saved inactivity days")).toHaveTextContent("30");
  });

  it.each(["", "0", "91", "1.5"])("discards invalid draft %j on blur", async (draft) => {
    await using screen = await render(<SettingsHarness />);
    const input = screen.getByRole("spinbutton");
    await input.fill(draft);
    await userEvent.keyboard("{Tab}");
    await expect.element(input).toHaveValue(14);
    await expect.element(screen.getByLabelText("Saved inactivity days")).toHaveTextContent("14");
  });

  it("replaces a draft when another client changes the saved value", async () => {
    const onCommit = vi.fn(async () => true);
    await using screen = await render(<AutoSettleDaysInput value={14} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton");
    await input.fill("1");
    await screen.rerender(<AutoSettleDaysInput value={45} onCommit={onCommit} />);
    await expect.element(input).toHaveValue(45);
    await userEvent.keyboard("{Tab}");
    expect(onCommit).not.toHaveBeenCalled();
  });
});
