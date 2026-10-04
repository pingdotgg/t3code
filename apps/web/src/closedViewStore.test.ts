import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useClosedViewStore } from "./closedViewStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-2" as EnvironmentId, ThreadId.make("thread-A"));
const diff = (threadRef: typeof refA) =>
  ({ kind: "panel-tab", threadRef, surface: { kind: "diff", id: "diff" } }) as const;

beforeEach(() => {
  useClosedViewStore.setState({ entries: [] });
});

describe("closedViewStore", () => {
  it("keeps newest first, moves a re-closed tab to the front, and caps at 20", () => {
    const store = useClosedViewStore.getState();
    store.remember(diff(refA));
    store.remember(diff(refB));
    store.remember(diff(refA));
    expect(useClosedViewStore.getState().entries).toMatchObject([
      { threadRef: refA },
      { threadRef: refB },
    ]);

    for (let index = 0; index < 24; index++) {
      store.remember({
        kind: "panel-tab",
        threadRef: refA,
        surface: {
          kind: "file",
          id: `file:${index}`,
          relativePath: `${index}.ts`,
          revealLine: null,
          revealRequestId: 0,
        },
      });
    }
    const entries = useClosedViewStore.getState().entries;
    expect(entries).toHaveLength(20);
    expect(entries[0]).toMatchObject({ surface: { id: "file:23" } });
  });
});
