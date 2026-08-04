import { describe, expect, it } from "vite-plus/test";

import { resolveMobilePairingPayload } from "./useMobilePairing";

describe("resolveMobilePairingPayload", () => {
  it("uses the canonical browser and mobile pairing URL", () => {
    expect(resolveMobilePairingPayload("http://192.168.1.8:3773", "PAIR-CODE")).toBe(
      "http://192.168.1.8:3773/pair#token=PAIR-CODE",
    );
  });
});
