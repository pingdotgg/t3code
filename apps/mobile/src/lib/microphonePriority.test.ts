import { describe, expect, it } from "vite-plus/test";

import {
  type MicrophoneEntry,
  microphoneEntryKey,
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "./microphonePriority";

const iPhone = { uid: "Built-In Microphone", name: "iPhone Microphone", type: "MicrophoneBuiltIn" };
const airPods = { uid: "airpods", name: "Julius’s AirPods Pro", type: "BluetoothHFP" };
const bose = { uid: "bose", name: "Julius’s Bose QC", type: "BluetoothHFP" };
const civic = { uid: "civic", name: "Honda Civic", type: "BluetoothHFP" };
const carPlay = { uid: "carplay", name: "CarPlay", type: "CarAudio" };
const usb = { uid: "usb", name: "Shure MV7", type: "USBAudio" };

const keys = (order: ReadonlyArray<MicrophoneEntry>) => order.map(microphoneEntryKey);

describe("microphoneOrder", () => {
  it("lists every kind once, CarPlay below the built-in microphone by default", () => {
    expect(keys(microphoneOrder())).toEqual([
      "kind:wired",
      "kind:bluetooth",
      "kind:builtIn",
      "kind:carPlay",
    ]);
  });

  it("keeps a saved order and files missing kinds after their devices", () => {
    const saved: MicrophoneEntry[] = [
      { kind: "builtIn" },
      { kind: "bluetooth", uid: "airpods", name: "AirPods" },
      { kind: "builtIn" },
    ];
    expect(keys(microphoneOrder(saved))).toEqual([
      "kind:wired",
      "kind:builtIn",
      "airpods",
      "kind:bluetooth",
      "kind:carPlay",
    ]);
  });
});

describe("rememberMicrophones", () => {
  it("lists a new device just above its kind and leaves built-in and CarPlay as kinds", () => {
    const order = microphoneOrder();
    expect(keys(rememberMicrophones(order, [iPhone, carPlay, airPods]))).toEqual([
      "kind:wired",
      "airpods",
      "kind:bluetooth",
      "kind:builtIn",
      "kind:carPlay",
    ]);
  });

  it("refreshes renamed devices and returns the same order when nothing changed", () => {
    const order = rememberMicrophones(microphoneOrder(), [airPods]);
    expect(rememberMicrophones(order, [airPods, iPhone])).toBe(order);

    const renamed = rememberMicrophones(order, [{ ...airPods, name: "AirPods Max" }]);
    expect(renamed.find((entry) => microphoneEntryKey(entry) === "airpods")).toEqual({
      kind: "bluetooth",
      uid: "airpods",
      name: "AirPods Max",
    });
  });
});

describe("preferredMicrophoneInput", () => {
  // Built-in, Bose, Wired, other Bluetooth, AirPods, CarPlay.
  const order: MicrophoneEntry[] = [
    { kind: "builtIn" },
    { kind: "bluetooth", uid: "bose", name: bose.name },
    { kind: "wired" },
    { kind: "bluetooth" },
    { kind: "bluetooth", uid: "airpods", name: airPods.name },
    { kind: "carPlay" },
  ];

  it("ranks unlisted devices of a kind at that kind, ahead of a device listed below it", () => {
    expect(preferredMicrophoneInput([airPods, civic], order)).toBe(civic);
    expect(preferredMicrophoneInput([airPods, bose], order)).toBe(bose);
    expect(preferredMicrophoneInput([airPods, usb], order)).toBe(usb);
    expect(preferredMicrophoneInput([airPods, carPlay], order)).toBe(airPods);
    expect(preferredMicrophoneInput([airPods, iPhone], order)).toBe(iPhone);
  });

  it("leaves inputs of unknown kinds to iOS", () => {
    expect(preferredMicrophoneInput([{ uid: "x", name: "x", type: "Virtual" }], order)).toBeNull();
  });
});
