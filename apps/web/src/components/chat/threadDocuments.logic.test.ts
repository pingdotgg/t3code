import { describe, expect, it } from "vite-plus/test";
import { resolveDocumentPath, threadDocumentsRevision } from "./threadDocuments.logic";

type Projection = Parameters<typeof threadDocumentsRevision>[0] & {};

const projection = (
  turnItems: ReadonlyArray<{ id: string; type: string; status: string }>,
  subagents: ReadonlyArray<{ childThreadId: string | null; status: string }> = [],
) => ({ turnItems, subagents }) as unknown as Projection;

describe("threadDocumentsRevision", () => {
  it("moves when a file change completes or a delegated task changes status", () => {
    const running = projection([{ id: "a", type: "file_change", status: "running" }]);
    const done = projection([{ id: "a", type: "file_change", status: "completed" }]);
    const withCommand = projection([
      { id: "a", type: "file_change", status: "completed" },
      { id: "b", type: "command_execution", status: "completed" },
    ]);
    expect(threadDocumentsRevision(running)).not.toBe(threadDocumentsRevision(done));
    expect(threadDocumentsRevision(withCommand)).toBe(threadDocumentsRevision(done));

    const taskRunning = projection([], [{ childThreadId: "child", status: "running" }]);
    const taskDone = projection([], [{ childThreadId: "child", status: "completed" }]);
    // A provider's own subagent works in this thread, so its file changes already count here.
    const nativeDone = projection([], [{ childThreadId: null, status: "completed" }]);
    expect(threadDocumentsRevision(taskRunning)).not.toBe(threadDocumentsRevision(taskDone));
    expect(threadDocumentsRevision(nativeDone)).toBe(threadDocumentsRevision(projection([])));
  });
});

describe("resolveDocumentPath", () => {
  it("keeps absolute paths and resolves relative ones against the workspace", () => {
    expect(resolveDocumentPath("/notes/plan.md", "/repo")).toBe("/notes/plan.md");
    expect(resolveDocumentPath("C:\\notes\\plan.md", null)).toBe("C:\\notes\\plan.md");
    expect(resolveDocumentPath("./docs/plan.md", "/repo/")).toBe("/repo/docs/plan.md");
    expect(resolveDocumentPath("docs\\plan.md", "C:\\repo")).toBe("C:\\repo\\docs\\plan.md");
    expect(resolveDocumentPath("docs/plan.md", null)).toBeNull();
  });
});
