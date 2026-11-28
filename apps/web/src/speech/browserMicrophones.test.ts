import { expect, it, vi } from "vite-plus/test";
import type { MicrophoneEntry } from "./microphoneOrder";
import { chooseRecordingMicrophone } from "./browserMicrophones";

const { update, getSettings } = vi.hoisted(() => ({
  update: vi.fn(),
  getSettings: vi.fn<() => { voiceMicrophones: MicrophoneEntry[]; voiceMicrophone: string }>(),
}));
vi.mock("../hooks/useSettings", () => ({
  getClientSettings: getSettings,
  isClientSettingsHydrated: () => true,
  updateClientSettings: update,
}));

it.each(["", "headset"])(
  "requests %j before discovery finishes and still remembers new devices",
  async (preferredId) => {
    getSettings.mockReturnValue({ voiceMicrophones: [], voiceMicrophone: preferredId });
    const scan = Promise.withResolvers<MediaDeviceInfo[]>();
    using _navigator = vi.spyOn(globalThis, "navigator", "get").mockReturnValue({
      mediaDevices: { enumerateDevices: () => scan.promise },
    } as unknown as Navigator);
    const saved = Promise.withResolvers<unknown>();
    update.mockImplementationOnce(saved.resolve);
    expect(await chooseRecordingMicrophone()).toBe(preferredId);
    scan.resolve([{ deviceId: "usb", label: "USB mic", kind: "audioinput" } as MediaDeviceInfo]);
    expect(await saved.promise).toEqual({
      voiceMicrophones: [
        ...(preferredId ? [{ kind: "device", deviceId: preferredId, label: "" }] : []),
        { kind: "default" },
        { kind: "device", deviceId: "usb", label: "USB mic" },
      ],
    });
  },
);

it("uses the second preferred microphone ahead of default when the first is disconnected", async () => {
  getSettings.mockReturnValue({
    voiceMicrophone: "",
    voiceMicrophones: [
      { kind: "device", deviceId: "desk", label: "Desk mic" },
      { kind: "device", deviceId: "usb", label: "USB mic" },
      { kind: "default" },
    ],
  });
  using _navigator = vi.spyOn(globalThis, "navigator", "get").mockReturnValue({
    mediaDevices: {
      enumerateDevices: async () => [{ deviceId: "usb", label: "USB mic", kind: "audioinput" }],
    },
  } as unknown as Navigator);
  expect(await chooseRecordingMicrophone()).toBe("usb");
});
