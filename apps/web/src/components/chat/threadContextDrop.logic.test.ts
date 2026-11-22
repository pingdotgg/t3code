import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";
import { droppedThreadContextRecord } from "./threadContextDrop.logic";

describe("droppedThreadContextRecord", () => {
  it.each([null, { title: "Cached title" }])(
    "uses the search result title even when the sidebar shell is %s",
    (shell) => {
      const ref = {
        environmentId: EnvironmentId.make("remote"),
        threadId: ThreadId.make("search-result"),
        title: "Search result",
      };
      expect(droppedThreadContextRecord(ref, shell)).toEqual(threadContextRecord(ref, ref.title));
    },
  );

  it("uses the sidebar title for a drag without search metadata", () => {
    const ref = {
      environmentId: EnvironmentId.make("local"),
      threadId: ThreadId.make("sidebar-thread"),
    };
    expect(droppedThreadContextRecord(ref, { title: "Sidebar thread" })).toEqual(
      threadContextRecord(ref, "Sidebar thread"),
    );
    expect(droppedThreadContextRecord(ref, null)).toBeNull();
  });
});
