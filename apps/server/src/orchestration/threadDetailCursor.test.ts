import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  decodeThreadDetailPageCursor,
  encodeThreadDetailPageCursor,
} from "./threadDetailCursor.ts";

describe("threadDetailCursor", () => {
  it("round-trips a sequence cursor while retaining its timestamp tiebreaker", () => {
    const cursor = {
      threadId: ThreadId.make("thread-1"),
      beforeSequence: 273,
      beforeAnchorAt: "2026-09-04T17:18:56.456Z",
      beforeTurnId: "turn-9",
    };
    expect(decodeThreadDetailPageCursor(encodeThreadDetailPageCursor(cursor))).toEqual(cursor);
  });

  it.each([-1, 1.5, "273", null, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid sequence boundary %j",
    (sequence) => {
      const encoded = Buffer.from(
        JSON.stringify({ t: "thread-1", a: "", i: "", v: 2, s: sequence }),
      ).toString("base64url");
      expect(decodeThreadDetailPageCursor(encoded)).toBeNull();
    },
  );

  it("round-trips a cursor", () => {
    const cursor = {
      threadId: ThreadId.make("thread-1"),
      beforeAnchorAt: "2026-08-01T00:00:00.000Z",
      beforeTurnId: "turn-9",
    };
    expect(decodeThreadDetailPageCursor(encodeThreadDetailPageCursor(cursor))).toEqual(cursor);
  });

  it("round-trips empty boundary values", () => {
    // The anchor is COALESCE(requested_at, started_at, '') and the turn key
    // is COALESCE(turn_id, ''), so a server-minted cursor can legitimately
    // carry empty strings; rejecting them would degrade a valid cursor to a
    // first-page request that repeats recent history (review finding).
    const cursor = {
      threadId: ThreadId.make("thread-1"),
      beforeAnchorAt: "",
      beforeTurnId: "",
    };
    expect(decodeThreadDetailPageCursor(encodeThreadDetailPageCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed input", () => {
    expect(decodeThreadDetailPageCursor("not-base64-json")).toBeNull();
    expect(decodeThreadDetailPageCursor(Buffer.from("[]").toString("base64url"))).toBeNull();
    expect(
      decodeThreadDetailPageCursor(Buffer.from(JSON.stringify({ t: "" })).toString("base64url")),
    ).toBeNull();
    expect(
      decodeThreadDetailPageCursor(
        Buffer.from(JSON.stringify({ t: "thread-1", a: 5, i: "x" })).toString("base64url"),
      ),
    ).toBeNull();
  });
});
