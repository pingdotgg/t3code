import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { getClientSettings } from "../../hooks/useSettings";
import { DeviceSettingsImportDialog } from "./DeviceSettingsFileActions";

const ONBOARDED_AT = "2026-10-01T00:00:00.000Z";

function setup() {
  localStorage.clear();
  localStorage.setItem(
    "t3code:client-settings:v1",
    JSON.stringify({ onboardingCompletedAt: ONBOARDED_AT, wordWrap: false }),
  );
  return { [Symbol.dispose]: () => localStorage.clear() };
}

it("shows the changes a file makes and merges them on confirmation", async () => {
  using _storage = setup();
  const onImported = vi.fn();
  const onOpenChange = vi.fn();
  await using _screen = await render(
    <DeviceSettingsImportDialog open onImported={onImported} onOpenChange={onOpenChange} />,
  );

  const file = new File(
    [JSON.stringify({ chatWidth: "wide", sendShortcut: 7, addedInALaterVersion: true })],
    "t3code-device-settings.json",
    { type: "application/json" },
  );
  await userEvent.upload(page.getByLabelText("Device settings file"), file);

  const changes = page.getByRole("list", { name: "Changes" });
  await expect.element(changes.getByText('chatWidth: "comfortable" → "wide"')).toBeVisible();
  const warnings = page.getByRole("list", { name: "Warnings" });
  await expect
    .element(warnings.getByText("sendShortcut: invalid value, kept the current one"))
    .toBeVisible();
  await expect
    .element(warnings.getByText("addedInALaterVersion: not a device setting, ignored"))
    .toBeVisible();

  await act(async () =>
    (page.getByRole("button", { name: "Apply settings" }).element() as HTMLButtonElement).click(),
  );

  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(onImported).toHaveBeenCalledOnce();
  expect(getClientSettings()).toMatchObject({
    chatWidth: "wide",
    wordWrap: false,
    sendShortcut: "enter",
    onboardingCompletedAt: ONBOARDED_AT,
  });
});
