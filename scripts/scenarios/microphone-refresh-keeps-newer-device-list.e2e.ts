/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    microphoneEnumeration?: {
      holdOldScan(): void;
      readonly oldScanStarted: Promise<void>;
      disconnectUsbMicrophone(): void;
      releaseOldScan(): void;
    };
  }
}

test(
  "A slow microphone scan cannot bring back a disconnected microphone",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    await browser.addInitScript(() => {
      const devices = navigator.mediaDevices;
      const internalMic = {
        kind: "audioinput",
        deviceId: "internal",
        label: "Internal test microphone",
      };
      const usbMic = { kind: "audioinput", deviceId: "usb", label: "USB test microphone" };
      let connected = [internalMic, usbMic];
      let holdNext = false;
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      // Emulate device snapshots when each enumeration starts and vary their delivery order.
      Object.defineProperty(devices, "enumerateDevices", {
        value: async () => {
          const snapshot = connected;
          if (holdNext) {
            holdNext = false;
            started.resolve();
            await release.promise;
          }
          return snapshot;
        },
      });
      window.microphoneEnumeration = {
        holdOldScan: () => {
          holdNext = true;
        },
        oldScanStarted: started.promise,
        disconnectUsbMicrophone: () => {
          connected = [internalMic];
          devices.dispatchEvent(new Event("devicechange"));
        },
        releaseOldScan: release.resolve,
      };
    });

    await t3.open("/settings/voice");
    const moveUsbUp = screen.getByRole("button", "Move USB test microphone up", { exact: true });
    await moveUsbUp.waitFor();
    while (await moveUsbUp.isEnabled()) await moveUsbUp.tap();

    const list = screen.getByRole("list", "Microphones, preferred first", { exact: true });
    const usbRow = list.getByRole("listitem").filter({ hasText: "USB test microphone" });
    await usbRow.getByText("In use", { exact: true }).waitFor();

    await browser.evaluate(() => {
      window.microphoneEnumeration!.holdOldScan();
      return null;
    });
    await screen.getByRole("button", "Refresh microphones", { exact: true }).tap();
    await browser.evaluate(async () => {
      await window.microphoneEnumeration!.oldScanStarted;
      window.microphoneEnumeration!.disconnectUsbMicrophone();
      return null;
    });
    const disconnected = usbRow.getByText("Not connected", { exact: true });
    await disconnected.waitFor();

    await browser.evaluate(async () => {
      window.microphoneEnumeration!.releaseOldScan();
      // Sample after the delivered device list has had a chance to paint.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return null;
    });
    await app.screenshot("after-stale-microphone-scan");
    expect(
      await disconnected.isVisible(),
      "The unplugged microphone remains marked Not connected",
    ).toBe(true);
  },
);
