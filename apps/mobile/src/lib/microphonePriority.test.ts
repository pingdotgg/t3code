import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_MICROPHONE_PRIORITY,
  preferredMicrophoneInput,
  resolveMicrophonePriority,
} from "./microphonePriority";

const builtIn = { uid: "built-in", type: "MicrophoneBuiltIn" };
const airPods = { uid: "airpods", type: "BluetoothHFP" };
const carPlay = { uid: "car", type: "CarAudio" };
const usb = { uid: "usb", type: "USBAudio" };

describe("resolveMicrophonePriority", () => {
  it("keeps the saved order and appends kinds it does not mention", () => {
    expect(resolveMicrophonePriority(["builtIn", "carPlay", "builtIn"])).toEqual([
      "builtIn",
      "carPlay",
      "wired",
      "bluetooth",
    ]);
    expect(resolveMicrophonePriority(undefined)).toEqual(DEFAULT_MICROPHONE_PRIORITY);
  });
});

describe("preferredMicrophoneInput", () => {
  it("records from the device instead of CarPlay by default", () => {
    const priority = resolveMicrophonePriority(undefined);
    expect(preferredMicrophoneInput([carPlay, builtIn], priority)).toBe(builtIn);
    expect(preferredMicrophoneInput([builtIn, airPods], priority)).toBe(airPods);
  });

  it("follows the saved order", () => {
    const priority = resolveMicrophonePriority(["builtIn"]);
    expect(preferredMicrophoneInput([airPods, usb, builtIn], priority)).toBe(builtIn);
    expect(preferredMicrophoneInput([airPods, usb], priority)).toBe(usb);
  });

  it("leaves unknown inputs to iOS", () => {
    const priority = resolveMicrophonePriority(undefined);
    expect(preferredMicrophoneInput([{ uid: "x", type: "Virtual" }], priority)).toBeNull();
  });
});
