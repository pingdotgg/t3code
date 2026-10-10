import { describe, expect, it } from "vite-plus/test";

import { preferredMicrophoneInput, rememberMicrophones } from "./microphonePriority";

const iPhone = { uid: "Built-In Microphone", name: "iPhone Microphone", type: "MicrophoneBuiltIn" };
const airPods = { uid: "airpods", name: "Dak’s AirPods Pro", type: "BluetoothHFP" };
const bluetoothCar = { uid: "civic", name: "Honda Civic", type: "BluetoothHFP" };
const carPlay = { uid: "carplay", name: "CarPlay", type: "CarAudio" };
const usb = { uid: "usb", name: "Shure MV7", type: "USBAudio" };

const uids = (microphones: ReadonlyArray<{ readonly uid: string }>) =>
  microphones.map((microphone) => microphone.uid);

describe("rememberMicrophones", () => {
  it("remembers new microphones in the default order, CarPlay below the iPhone", () => {
    expect(uids(rememberMicrophones([], [carPlay, iPhone, airPods]))).toEqual([
      "airpods",
      "Built-In Microphone",
      "carplay",
    ]);
  });

  it("files a new device after the last one of its kind, keeping the user's order", () => {
    const reordered = rememberMicrophones([], [iPhone, airPods]).toReversed();
    expect(uids(reordered)).toEqual(["Built-In Microphone", "airpods"]);

    expect(uids(rememberMicrophones(reordered, [bluetoothCar, iPhone]))).toEqual([
      "Built-In Microphone",
      "airpods",
      "civic",
    ]);
    expect(uids(rememberMicrophones(reordered, [usb]))).toEqual([
      "usb",
      "Built-In Microphone",
      "airpods",
    ]);
  });

  it("updates a renamed device in place and returns the same list when nothing changed", () => {
    const remembered = rememberMicrophones([], [iPhone, airPods]);
    expect(rememberMicrophones(remembered, [iPhone, airPods])).toBe(remembered);
    expect(rememberMicrophones(remembered, [{ uid: "virtual", name: "x", type: "Virtual" }])).toBe(
      remembered,
    );

    const renamed = rememberMicrophones(remembered, [{ ...airPods, name: "AirPods Max" }]);
    expect(renamed.map((microphone) => microphone.name)).toEqual([
      "AirPods Max",
      "iPhone Microphone",
    ]);
  });
});

describe("preferredMicrophoneInput", () => {
  it("records from the first connected remembered microphone", () => {
    const remembered = rememberMicrophones([], [iPhone, airPods, bluetoothCar]).toReversed();
    expect(preferredMicrophoneInput([airPods, iPhone], remembered)).toBe(iPhone);
    expect(preferredMicrophoneInput([airPods, bluetoothCar], remembered)).toBe(bluetoothCar);
  });

  it("leaves microphones it does not know to iOS", () => {
    expect(preferredMicrophoneInput([usb], rememberMicrophones([], [iPhone]))).toBeNull();
  });
});
