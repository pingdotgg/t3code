import { assert, describe, it } from "@effect/vitest";

import { makeCachedCursorAccessTokenReader } from "./cursorCredentialStore.ts";

describe("Cursor Keychain reader", () => {
  it("shares concurrent reads and rechecks after the cache expires", async () => {
    let reads = 0;
    let time = 0;
    const read = makeCachedCursorAccessTokenReader(
      async () => {
        reads++;
        return `token-${reads}`;
      },
      () => time,
    );
    assert.deepStrictEqual(await Promise.all([read(), read()]), ["token-1", "token-1"]);
    assert.strictEqual(await read(), "token-1");
    assert.strictEqual(reads, 1);
    time = 5 * 60_000;
    assert.strictEqual(await read(), "token-2");
  });
});
