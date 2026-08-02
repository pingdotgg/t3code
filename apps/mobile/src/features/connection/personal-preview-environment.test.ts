import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: {} } },
}));

import { parsePersonalPreviewDefaultEnvironmentHost } from "./personal-preview-environment";

describe("personal preview default environment", () => {
  it("accepts a plain HTTP or HTTPS origin", () => {
    expect(parsePersonalPreviewDefaultEnvironmentHost(" http://100.97.53.68:7791/ ")).toBe(
      "http://100.97.53.68:7791",
    );
    expect(parsePersonalPreviewDefaultEnvironmentHost("https://vps.tailnet.ts.net")).toBe(
      "https://vps.tailnet.ts.net",
    );
  });

  it("rejects credentials, paths, and unsupported schemes", () => {
    expect(parsePersonalPreviewDefaultEnvironmentHost("https://user:secret@example.test")).toBe("");
    expect(parsePersonalPreviewDefaultEnvironmentHost("https://example.test/private")).toBe("");
    expect(parsePersonalPreviewDefaultEnvironmentHost("file:///tmp/environment")).toBe("");
  });
});
