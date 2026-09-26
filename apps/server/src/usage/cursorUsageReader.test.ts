import { assert, describe, it } from "@effect/vitest";

import { CursorKeychainTimeoutError } from "../provider/cursorCredentialStore.ts";
import { readCursorAccountUsage } from "./cursorUsageReader.ts";

describe("readCursorAccountUsage", () => {
  it("asks for Keychain approval when the prompt goes unanswered", async () => {
    const result = await readCursorAccountUsage(
      { kind: "keychain" },
      0,
      1,
      () => Promise.reject(new Error("no network expected")),
      () => Promise.reject(new CursorKeychainTimeoutError()),
    );
    assert.deepStrictEqual(result, {
      accountKey: null,
      records: [],
      missing: false,
      error: "Allow Keychain access on the Mac running T3 Code, then refresh.",
    });
  });
});
