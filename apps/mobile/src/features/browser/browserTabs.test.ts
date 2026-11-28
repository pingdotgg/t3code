import { describe, expect, it } from "vite-plus/test";

import { localPreviewUrlForDevice, loopbackUrlForDevice } from "./browserTabs";

describe("loopbackUrlForDevice", () => {
  it("opens only the environment's loopback pages on this device", () => {
    expect(loopbackUrlForDevice("http://localhost:5173/app?x=1")).toBe(
      "http://localhost:5173/app?x=1",
    );
    expect(loopbackUrlForDevice("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000/");
    expect(loopbackUrlForDevice("http://[::1]:3000/")).toBe("http://[::1]:3000/");
    // The unspecified address would name the phone's own interfaces.
    expect(loopbackUrlForDevice("http://0.0.0.0:3000/")).toBe("http://localhost:3000/");
    expect(loopbackUrlForDevice("http://[::]:3000/")).toBe("http://localhost:3000/");
    expect(loopbackUrlForDevice("https://example.com/")).toBeNull();
    expect(loopbackUrlForDevice("http://192.168.1.5:3000/")).toBeNull();
    expect(loopbackUrlForDevice("file:///tmp/a.html")).toBeNull();
    expect(loopbackUrlForDevice("")).toBeNull();
  });
});

describe("localPreviewUrlForDevice", () => {
  it("loads http and https addresses and nothing else", () => {
    expect(localPreviewUrlForDevice("http://0.0.0.0:3000/")).toBe("http://localhost:3000/");
    expect(localPreviewUrlForDevice("https://example.com/docs")).toBe("https://example.com/docs");
    expect(localPreviewUrlForDevice(" JavaScript:void(0)")).toBeNull();
    expect(localPreviewUrlForDevice("file:///tmp/a.html")).toBeNull();
    expect(localPreviewUrlForDevice("data:text/html,hello")).toBeNull();
    expect(localPreviewUrlForDevice("")).toBeNull();
  });
});
