import { expect, test } from "bun:test";
import { pairingCode } from "./pairing-input.ts";

test("accepts pairing URLs and rejects bare codes", () => {
  const url = "https://mac.example/#token=private-code";
  expect(pairingCode("  private-code  ")).toBeNull();
  expect(pairingCode(url)).toBe("private-code");
  expect(pairingCode("https://app.example/?host=mac.example&token=private-code")).toBe("private-code");
  expect(pairingCode(`t3code://pair?pairingUrl=${encodeURIComponent(url)}`)).toBe("private-code");
  expect(pairingCode("https://mac.example/")).toBeNull();
});
