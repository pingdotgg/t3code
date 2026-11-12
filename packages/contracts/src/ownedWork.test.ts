import { describe, expect, it } from "@effect/vitest";

import { OwnedWorkItemId, ThreadId } from "./baseSchemas.ts";
import { ownedWorkInboxRelevant, type OwnedWorkItem } from "./ownedWork.ts";

const actor = ThreadId.make("thread:actor");
const home = ThreadId.make("thread:home");
const other = ThreadId.make("thread:other");

const baseItem = {
  id: OwnedWorkItemId.make("owned-work:1"),
  title: "Ship client",
  description: "",
  progress: null,
  holdReason: null,
  attentionReason: null,
  handoffNote: null,
  closureReason: null,
  closureTarget: null,
  closureNote: null,
  history: [],
  createdByThreadId: home,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  claimedAt: null,
  completedAt: null,
} satisfies Omit<OwnedWorkItem, "status" | "assigneeThreadId" | "claimedByThreadId">;

describe("ownedWorkInboxRelevant", () => {
  it("includes assigned work destined for the actor", () => {
    expect(
      ownedWorkInboxRelevant(
        {
          ...baseItem,
          status: "assigned",
          assigneeThreadId: actor,
          claimedByThreadId: null,
        },
        actor,
      ),
    ).toBe(true);
  });

  it("excludes assigned work destined for someone else", () => {
    expect(
      ownedWorkInboxRelevant(
        {
          ...baseItem,
          status: "assigned",
          assigneeThreadId: other,
          claimedByThreadId: null,
        },
        actor,
      ),
    ).toBe(false);
  });

  it("includes work the actor already claimed", () => {
    expect(
      ownedWorkInboxRelevant(
        {
          ...baseItem,
          status: "in_progress",
          assigneeThreadId: actor,
          claimedByThreadId: actor,
          progress: "halfway",
        },
        actor,
      ),
    ).toBe(true);
  });

  it("excludes closed work", () => {
    expect(
      ownedWorkInboxRelevant(
        {
          ...baseItem,
          status: "completed",
          assigneeThreadId: actor,
          claimedByThreadId: actor,
          completedAt: "2026-06-20T01:00:00.000Z",
          closureReason: "done",
        },
        actor,
      ),
    ).toBe(false);
  });
});
