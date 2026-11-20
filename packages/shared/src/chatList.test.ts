import { describe, expect, it } from "vite-plus/test";

import { CHAT_LIST_ANCHOR_OFFSET, resolveChatListAnchoredEndSpace } from "./chatList.ts";

interface Row {
  readonly kind: "message" | "tool";
  readonly id: string;
}

const row = (kind: Row["kind"], id: string): Row => ({ kind, id });
const anchorIdOf = (item: Row) => (item.kind === "message" ? item.id : null);

describe("resolveChatListAnchoredEndSpace", () => {
  it("returns undefined when no anchor is requested", () => {
    expect(
      resolveChatListAnchoredEndSpace([row("message", "a")], null, anchorIdOf),
    ).toBeUndefined();
  });

  it("returns undefined when the anchor id is not in the list", () => {
    expect(
      resolveChatListAnchoredEndSpace(
        [row("message", "a"), row("message", "b")],
        "missing",
        anchorIdOf,
      ),
    ).toBeUndefined();
  });

  it("finds the anchor at the first item", () => {
    expect(
      resolveChatListAnchoredEndSpace([row("message", "a"), row("tool", "t")], "a", anchorIdOf),
    ).toEqual({ anchorIndex: 0, anchorOffset: CHAT_LIST_ANCHOR_OFFSET });
  });

  it("finds the anchor after earlier anchored items", () => {
    expect(
      resolveChatListAnchoredEndSpace(
        [row("message", "first"), row("tool", "t"), row("message", "latest")],
        "latest",
        anchorIdOf,
      ),
    ).toEqual({ anchorIndex: 2, anchorOffset: CHAT_LIST_ANCHOR_OFFSET });
  });

  it("keeps scanning past items whose anchor id is null", () => {
    expect(
      resolveChatListAnchoredEndSpace(
        [row("tool", "t1"), row("tool", "t2"), row("message", "a")],
        "a",
        anchorIdOf,
      ),
    ).toEqual({ anchorIndex: 2, anchorOffset: CHAT_LIST_ANCHOR_OFFSET });
  });

  it("honors a custom anchorOffset", () => {
    expect(
      resolveChatListAnchoredEndSpace([row("message", "a")], "a", anchorIdOf, {
        anchorOffset: 42,
      }),
    ).toEqual({ anchorIndex: 0, anchorOffset: 42 });
  });
});
