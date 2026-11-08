import { expect, test } from "vite-plus/test";
import pairing from "../src/pkjs/pairing.js";
import storage from "../src/pkjs/storage.js";
import { installStorage } from "./xhr-shim.ts";

test("ignores credentials saved for the retired companion", () => {
  const saved = installStorage({ url: "https://companion.example", token: "companion-token" });
  try {
    expect(storage.origin()).toBe("");
    expect(storage.token()).toBe("");
  } finally {
    saved.restore();
  }
});

test("accepts full pairing URLs and rejects bare codes", () => {
  const url = "https://mac.example/#token=private-code";
  expect(pairing.code("  private-code  ")).toBeNull();
  expect(pairing.code(url)).toBe("private-code");
  expect(pairing.code("https://app.example/?host=mac.example&token=private-code")).toBe(
    "private-code",
  );
  expect(pairing.code(`t3code://pair?pairingUrl=${encodeURIComponent(url)}`)).toBe("private-code");
  expect(pairing.code("https://mac.example/")).toBeNull();
});

test("derives the daemon origin from the pairing URL", () => {
  expect(pairing.parse("https://mac.example:9383/#token=abc")).toEqual({
    origin: "https://mac.example:9383",
    code: "abc",
  });
  expect(pairing.parse("wss://mac.example/ws#token=abc")).toEqual({
    origin: "https://mac.example",
    code: "abc",
  });
  expect(
    pairing.parse(
      "t3code://pair?pairingUrl=" + encodeURIComponent("http://127.0.0.1:1234/#token=abc"),
    ),
  ).toEqual({ origin: "http://127.0.0.1:1234", code: "abc" });
  expect(pairing.parse("https://mac.example/#token=")).toBeNull();
  expect(pairing.parse("not a url")).toBeNull();
});
