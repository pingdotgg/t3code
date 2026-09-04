import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeTailcatAddress,
  isTailcatAddressSyntax,
  isTailcatNodeKey,
  tailcatKeyFingerprint,
} from "./address.ts";

// Captured from a real `tailcat serve` run (server key 7ea7…ff32, region 302).
const ADDRESS =
  "tco2FwWCB-p3FjjOrzlCPp0w8aT3p9xDZ1nNaXWX_dASxDCFT_MmFrWCDRnh2-iykbZ7W4Fl0g3nBpwTnR3iXVCKKCk4pps47ndGFpGQEu";

describe("tailcat address", () => {
  it("decodes the server key, disco key and region from a real address", () => {
    const decoded = decodeTailcatAddress(ADDRESS);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.serverNodeKey).toBe(
        "nodekey:7ea771638ceaf39423e9d30f1a4f7a7dc436759cd697597fdd012c430854ff32",
      );
      expect(decoded.success.serverDiscoKey).toBe(
        "discokey:d19e1dbe8b291b67b5b8165d20de7069c139d1de25d508a282938a69b38ee774",
      );
      expect(decoded.success.regionId).toBe(302);
      expect(decoded.success.hasEmbeddedRegions).toBe(false);
    }
  });

  it("rejects malformed addresses without throwing", () => {
    expect(Result.isFailure(decodeTailcatAddress("tcgarbage"))).toBe(true);
    expect(Result.isFailure(decodeTailcatAddress("https://example.com"))).toBe(true);
    expect(Result.isFailure(decodeTailcatAddress(`${ADDRESS}AAAA`))).toBe(true);
    const truncated = decodeTailcatAddress(ADDRESS.slice(0, 40));
    expect(Result.isFailure(truncated)).toBe(true);
  });

  it("validates syntax and node keys", () => {
    expect(isTailcatAddressSyntax(ADDRESS)).toBe(true);
    expect(isTailcatAddressSyntax("tc")).toBe(false);
    expect(
      isTailcatNodeKey("nodekey:9ab555a4a588b75d2054adb683db82461bb6c707d43e8ba39439f8eb1e821503"),
    ).toBe(true);
    expect(isTailcatNodeKey("nodekey:zz")).toBe(false);
  });

  it("renders short fingerprints", () => {
    expect(
      tailcatKeyFingerprint(
        "nodekey:9ab555a4a588b75d2054adb683db82461bb6c707d43e8ba39439f8eb1e821503",
      ),
    ).toBe("9ab5·55a4·1503");
  });
});
