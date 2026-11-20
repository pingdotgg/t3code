import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { VoiceInputSetup } from "./VoiceInputSetup";

function wizard(open: boolean) {
  return (
    <VoiceInputSetup
      open={open}
      step={1}
      environmentId={null}
      status={null}
      model={null}
      language={null}
      downloading={false}
      error={null}
      onOpenChange={() => {}}
      onRetryCatalog={null}
      onDownload={() => {}}
      onCancelDownload={() => {}}
      onStartRecording={() => {}}
    />
  );
}

it.each([
  { latest: "succeeded", disabled: false, showsError: false },
  { latest: "failed", disabled: false, showsError: true },
  { latest: "is pending after reopening", disabled: true, showsError: false },
] as const)(
  "ignores a superseded microphone refresh when the latest refresh $latest",
  async ({ latest, disabled, showsError }) => {
    await using screen = await render(wizard(false));
    const old = Promise.withResolvers<MediaDeviceInfo[]>();
    const current = Promise.withResolvers<MediaDeviceInfo[]>();
    const mediaDevices = navigator.mediaDevices;
    using _enumeration = vi
      .spyOn(mediaDevices, "enumerateDevices")
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);

    await screen.rerender(wizard(true));
    const picker = page.getByRole("combobox", { name: "Microphone", exact: true });
    const alert = page.getByRole("alert").filter({ hasText: "Couldn’t list microphones" });
    await expect.element(picker).toBeDisabled();

    if (latest === "is pending after reopening") {
      await screen.rerender(wizard(false));
      await screen.rerender(wizard(true));
    } else {
      await act(async () => {
        mediaDevices.dispatchEvent(new Event("devicechange"));
        if (latest === "failed") current.reject(new Error("Enumeration failed"));
        else current.resolve([]);
      });
      await expect.element(picker).toBeEnabled();
    }

    await act(async () => {
      if (latest === "succeeded") old.reject(new Error("Superseded enumeration failed"));
      else old.resolve([]);
    });
    if (disabled) expect(picker.element()).toBeDisabled();
    else expect(picker.element()).toBeEnabled();
    expect(alert.query()?.textContent ?? null).toBe(
      showsError ? "Couldn’t list microphones. The system default still works." : null,
    );

    if (disabled) {
      await act(async () => current.resolve([]));
      await expect.element(picker).toBeEnabled();
    }
  },
);
