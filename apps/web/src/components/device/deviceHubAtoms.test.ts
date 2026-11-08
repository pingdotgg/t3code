import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { androidFoldReadAtom } from "./deviceHubAtoms";

const mountFoldRead = (respond: () => Response) => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => respond());
  vi.stubGlobal("fetch", fetchMock);
  const release = AtomRegistry.make().mount(
    androidFoldReadAtom({
      deviceKey: "host-1:lease-1",
      access: {
        httpBase: "http://t3.test/api/device-hub",
        wsBase: "",
        query: {},
        credentials: true,
      },
      deviceId: "lease-1",
      screenWidth: 1080,
      screenHeight: 2400,
    }),
  );
  return {
    requests: () => fetchMock.mock.calls.length,
    [Symbol.dispose]: () => {
      release();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    },
  };
};

describe("androidFoldReadAtom", () => {
  it("reads once when the host has no fold endpoint", async () => {
    using fold = mountFoldRead(() => new Response("Not Found", { status: 404 }));

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fold.requests()).toBe(1);
  });

  it("keeps reading through hub errors until the fold arrives", async () => {
    const hubErrors = [new Response(null, { status: 400 }), new Response(null, { status: 409 })];
    using fold = mountFoldRead(
      () =>
        hubErrors.shift() ??
        Response.json({ ok: true, fold: { supported: true, posture: "opened", hingeAngle: 180 } }),
    );

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fold.requests()).toBe(3);
  });
});
