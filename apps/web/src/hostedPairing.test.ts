import { describe, expect, it } from "vite-plus/test";

import { hasHostedPairingRequest, readHostedPairingRequest } from "./hostedPairing";

describe("hostedPairing", () => {
  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://hosted.example/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });
});
