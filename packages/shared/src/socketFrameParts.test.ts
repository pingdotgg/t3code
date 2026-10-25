import { assert, it } from "@effect/vitest";

import { SOCKET_FRAME_PART_BYTES, splitSocketFrame } from "./socketFrameParts.ts";

it("splits a large frame into parts that each fit the budget and stay valid UTF-8", () => {
  // Surrogate pairs fall across part boundaries; splitting one would turn it into U+FFFD on the wire.
  const parts = splitSocketFrame("é€😀x".repeat(SOCKET_FRAME_PART_BYTES / 4));
  assert.isAbove(parts.length, 1);
  for (const part of parts) {
    const bytes = new TextEncoder().encode(part);
    assert.isAtMost(bytes.length, SOCKET_FRAME_PART_BYTES);
    assert.strictEqual(new TextDecoder().decode(bytes), part);
  }
});
