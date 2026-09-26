import { assert, describe, it } from "@effect/vitest";

import {
  CursorKeychainTimeoutError,
  makeCachedCursorAccessTokenReader,
} from "./cursorCredentialStore.ts";

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

  it("gives up on an unanswered prompt and reuses it on the next read", async () => {
    let reads = 0;
    let allow: (token: string) => void = () => {};
    const read = makeCachedCursorAccessTokenReader(
      () => {
        reads++;
        return new Promise((resolve) => {
          allow = resolve;
        });
      },
      () => 0,
      1,
    );
    const error = await read().catch((cause: unknown) => cause);
    assert.instanceOf(error, CursorKeychainTimeoutError);
    const retry = read();
    allow("token");
    assert.strictEqual(await retry, "token");
    assert.strictEqual(reads, 1);
  });
});
