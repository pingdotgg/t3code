import type { ApplicationStoredEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { coalesceShellApplicationEvents } from "./ShellStream.ts";

function project(sequence: number, id: string): ApplicationStoredEvent {
  return {
    sequence,
    aggregateKind: "project",
    aggregateId: id,
  } as ApplicationStoredEvent;
}

function thread(sequence: number, id: string): ApplicationStoredEvent {
  return {
    sequence,
    event: { threadId: id },
  } as ApplicationStoredEvent;
}

describe("coalesceShellApplicationEvents", () => {
  it("keeps the newest event per aggregate and preserves sequence order", () => {
    expect(
      coalesceShellApplicationEvents([
        thread(2, "thread-a"),
        project(3, "project-a"),
        thread(4, "thread-b"),
        thread(5, "thread-a"),
        project(6, "project-a"),
      ]).map((event) => event.sequence),
    ).toEqual([4, 5, 6]);
  });
});
