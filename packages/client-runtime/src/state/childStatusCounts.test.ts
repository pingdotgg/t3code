import { describe, expect, it } from "vite-plus/test";

import type { AgentThreadStatus } from "./agents.ts";
import {
  agentChildStatusBucket,
  countChildStatusBuckets,
  selectChildAvatars,
  toggleExpandedParentKey,
  type ChildStatusBucket,
} from "./childStatusCounts.ts";

describe("child status counts", () => {
  it("counts Agents board children by the status their rows show", () => {
    const statuses: AgentThreadStatus[] = [
      "attention",
      "running",
      "queued",
      "waiting",
      "idle",
      "error",
      "done",
      "done",
    ];
    expect(countChildStatusBuckets(statuses, agentChildStatusBucket)).toEqual({
      needsInput: 1,
      running: 2,
      waiting: 2,
      failed: 1,
      done: 2,
    });
  });
});

describe("child avatars", () => {
  const child = (id: string, bucket: ChildStatusBucket, updatedAt: string) => ({
    id,
    bucket,
    updatedAt,
  });

  it("orders by urgency, newest first within a state, and caps the rest as overflow", () => {
    const { shown, overflow } = selectChildAvatars([
      child("done", "done", "2026-11-01T05:00:00Z"),
      child("waiting-old", "waiting", "2026-11-01T01:00:00Z"),
      child("running", "running", "2026-11-01T02:00:00Z"),
      child("waiting-new", "waiting", "2026-11-01T04:00:00Z"),
      child("failed", "failed", "2026-11-01T00:00:00Z"),
      child("input", "needsInput", "2026-11-01T00:00:00Z"),
      child("waiting-mid", "waiting", "2026-11-01T03:00:00Z"),
    ]);
    expect(shown.map(({ id }) => id)).toEqual([
      "input",
      "failed",
      "running",
      "waiting-new",
      "waiting-mid",
    ]);
    expect(overflow).toBe(2);
  });

  it("keeps every child needing input or failed visible past the cap", () => {
    const urgent = Array.from({ length: 6 }, (_, index) =>
      child(`input-${index}`, index % 2 === 0 ? "needsInput" : "failed", "2026-11-01T00:00:00Z"),
    );
    const { shown, overflow } = selectChildAvatars([
      child("running", "running", "2026-11-01T09:00:00Z"),
      ...urgent,
    ]);
    expect(shown).toHaveLength(6);
    expect(shown.every(({ bucket }) => bucket !== "running")).toBe(true);
    expect(overflow).toBe(1);
  });
});

describe("expanded parent keys", () => {
  it("toggles a parent and drops the oldest past the bound", () => {
    expect(toggleExpandedParentKey(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleExpandedParentKey(["a"], "b")).toEqual(["a", "b"]);
    const full = Array.from({ length: 200 }, (_, index) => `p${index}`);
    const next = toggleExpandedParentKey(full, "new");
    expect(next).toHaveLength(200);
    expect(next[0]).toBe("p1");
    expect(next.at(-1)).toBe("new");
  });
});
