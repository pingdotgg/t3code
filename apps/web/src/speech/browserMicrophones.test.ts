import { expect, it, vi } from "vite-plus/test";
import { chooseRecordingMicrophone } from "./browserMicrophones";

const { update } = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => ({ voiceMicrophones: [], voiceMicrophone: "" }),
  isClientSettingsHydrated: () => true,
  updateClientSettings: update,
}));

it("opens the default microphone before discovery finishes and still remembers new devices", async () => {
  const scan = Promise.withResolvers<MediaDeviceInfo[]>();
  using _navigator = vi.spyOn(globalThis, "navigator", "get").mockReturnValue({
    mediaDevices: { enumerateDevices: () => scan.promise },
  } as unknown as Navigator);
  const saved = Promise.withResolvers<unknown>();
  update.mockImplementationOnce(saved.resolve);
  expect(await chooseRecordingMicrophone()).toBe("");
  scan.resolve([{ deviceId: "usb", label: "USB mic", kind: "audioinput" } as MediaDeviceInfo]);
  expect(await saved.promise).toEqual({
    voiceMicrophones: [{ kind: "default" }, { kind: "device", deviceId: "usb", label: "USB mic" }],
  });
});
