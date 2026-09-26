import { afterEach, expect, it, vi } from "vite-plus/test";
import { captureDeviceScreenshot, DeviceScreenshotError } from "./screenshot.ts";

afterEach(() => vi.unstubAllGlobals());
const target = {
  platform: "android" as const,
  deviceId: "phone with spaces",
  access: {
    httpBase: "https://remote.example/api/device-hub/hosts/remote",
    wsBase: "wss://remote.example",
    query: { ticket: "capture-ticket" },
    credentials: false,
  },
};

it("captures native bytes from the selected remote host with its media credentials", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } }),
  );
  vi.stubGlobal("fetch", fetch);
  const image = await captureDeviceScreenshot(target, new AbortController().signal);
  expect(image.type).toBe("image/png");
  expect(Array.from(new Uint8Array(await image.arrayBuffer()))).toEqual([137, 80, 78, 71]);
  expect(fetch).toHaveBeenCalledWith(
    "https://remote.example/api/device-hub/hosts/remote/vendor/serve-emu/api/screenshot?device=phone%20with%20spaces&ticket=capture-ticket",
    expect.objectContaining({ method: "POST", credentials: "omit" }),
  );
});

it("preserves authorization failures and cancels an in-flight capture when its owner detaches", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("expired", { status: 401 })),
  );
  await expect(captureDeviceScreenshot(target, new AbortController().signal)).rejects.toMatchObject(
    new DeviceScreenshotError(401),
  );
  vi.stubGlobal(
    "fetch",
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
  const controller = new AbortController();
  const capture = captureDeviceScreenshot(target, controller.signal);
  controller.abort(new Error("detached"));
  await expect(capture).rejects.toThrow("detached");
});
