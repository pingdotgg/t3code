import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  readScopedThreadRefFromDataTransfer,
  THREAD_SCOPED_DRAG_MIME,
  writeScopedThreadToDataTransfer,
} from "./threadSplitDnD";

function mockDataTransfer(map: Record<string, string>): DataTransfer {
  return {
    setData(type: string, data: string) {
      map[type] = data;
    },
    getData(type: string) {
      return map[type] ?? "";
    },
  } as DataTransfer;
}

describe("threadSplitDnD", () => {
  it("round-trips scoped thread refs through DataTransfer", () => {
    const store: Record<string, string> = {};
    const dt = mockDataTransfer(store);
    const ref = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
    writeScopedThreadToDataTransfer(dt, ref);
    expect(readScopedThreadRefFromDataTransfer(dt)).toEqual(ref);
  });

  it("reads from the text/plain fallback", () => {
    const store: Record<string, string> = {
      "text/plain": JSON.stringify({ environmentId: "env-2", threadId: "thread-2" }),
    };
    const dt = mockDataTransfer(store);
    expect(readScopedThreadRefFromDataTransfer(dt)).toEqual(
      scopeThreadRef(EnvironmentId.make("env-2"), ThreadId.make("thread-2")),
    );
  });

  it("prefers the custom MIME over text/plain", () => {
    const store: Record<string, string> = {
      [THREAD_SCOPED_DRAG_MIME]: JSON.stringify({
        environmentId: "env-a",
        threadId: "thread-a",
      }),
      "text/plain": JSON.stringify({ environmentId: "env-b", threadId: "thread-b" }),
    };
    const dt = mockDataTransfer(store);
    expect(readScopedThreadRefFromDataTransfer(dt)).toEqual(
      scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("thread-a")),
    );
  });
});
