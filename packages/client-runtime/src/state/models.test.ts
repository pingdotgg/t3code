import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isOpenListedThread } from "./models.ts";

describe("isOpenListedThread", () => {
  it("lists delegated child chats and hides subagents, side chats, and archived threads", () => {
    const parentId = ThreadId.make("parent");
    const subagentLineage = {
      rootThreadId: parentId,
      parentThreadId: parentId,
      relationshipToParent: "subagent" as const,
    };
    const thread = (
      overrides: Partial<Parameters<typeof isOpenListedThread>[0]> = {},
    ): Parameters<typeof isOpenListedThread>[0] => ({
      archivedAt: null,
      parentThreadId: null,
      parentRelationship: null,
      lineage: { rootThreadId: parentId, parentThreadId: null, relationshipToParent: null },
      ...overrides,
    });

    expect(isOpenListedThread(thread())).toBe(true);
    // A delegated child keeps the provider's subagent lineage but is its own chat.
    expect(
      isOpenListedThread(
        thread({ parentThreadId: parentId, parentRelationship: "child", lineage: subagentLineage }),
      ),
    ).toBe(true);
    expect(
      isOpenListedThread(
        thread({
          parentThreadId: parentId,
          parentRelationship: "subagent",
          lineage: subagentLineage,
        }),
      ),
    ).toBe(false);
    expect(
      isOpenListedThread(
        thread({ lineage: { ...subagentLineage, relationshipToParent: null, sideChat: true } }),
      ),
    ).toBe(false);
    expect(isOpenListedThread(thread({ archivedAt: "2026-11-01T00:00:00.000Z" }))).toBe(false);
  });
});
