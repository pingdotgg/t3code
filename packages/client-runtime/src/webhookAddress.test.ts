import { describe, expect, it } from "vite-plus/test";

import { webhookAddress } from "./webhookAddress.ts";

const path = "/api/hooks/scheduled-task%3Ahook/token";
const endpoint = (url: string | null) => ({ path, url, hasSecret: false });

describe("webhookAddress", () => {
  it("uses the T3 Connect URL when the server has one", () => {
    expect(webhookAddress(endpoint("https://relay.t3.codes/v1/hooks/k/t/x"), null)).toEqual({
      address: "https://relay.t3.codes/v1/hooks/k/t/x",
      copyable: true,
      note: null,
    });
  });

  it("builds a direct URL on the environment's address without T3 Connect", () => {
    const result = webhookAddress(endpoint(null), "https://mac.tail1234.ts.net/");
    expect(result.address).toBe(`https://mac.tail1234.ts.net${path}`);
    expect(result.copyable).toBe(true);
    expect(result.note).toContain("Tailscale");
  });

  it("says only this computer can call a loopback address", () => {
    const result = webhookAddress(endpoint(null), "http://127.0.0.1:3773/");
    expect(result.copyable).toBe(true);
    expect(result.note).toContain("Only this computer");
  });

  it("falls back to the path when the address is unknown", () => {
    expect(webhookAddress(endpoint(null), null)).toMatchObject({
      address: path,
      copyable: false,
    });
  });
});
