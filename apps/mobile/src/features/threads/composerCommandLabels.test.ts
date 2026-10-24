import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { matchComposerThreadItems } from "@t3tools/client-runtime/composerThreadItems";
import { describe, expect, it } from "vite-plus/test";

import { emptyText, groupLabel } from "./composerCommandLabels";

const environmentId = EnvironmentId.make("mention-labels");
const shells = [
  {
    environmentId,
    id: ThreadId.make("review"),
    title: "Review changes",
    updatedAt: "2026-10-18T00:00:00.000Z",
    archivedAt: null,
  },
];

function matchingThreads(query: string) {
  return matchComposerThreadItems({ shells, environmentId, excludeThreadId: null, query });
}

describe("composer command labels", () => {
  it("keeps the bare @ picker file-only", () => {
    expect(matchingThreads(" ")).toEqual([]);
    expect(groupLabel("path", false)).toBe("Files");
    expect(emptyText("path", false, false)).toBe("No matching files or folders.");
  });

  it("describes thread searches even when no thread title matches", () => {
    expect(matchingThreads("Rev")).toHaveLength(1);
    expect(groupLabel("path", true)).toBe("Threads and files");
    expect(matchingThreads("no-match")).toEqual([]);
    expect(groupLabel("path", true)).toBe("Threads and files");
    expect(emptyText("path", false, true)).toBe("No matching threads, files, or folders.");
  });

  it("describes the search scope while file results are loading", () => {
    expect(emptyText("path", true, true)).toBe("Searching threads and files…");
    expect(emptyText("path", true, false)).toBe("Searching files…");
  });

  it("keeps other command menus unchanged", () => {
    expect(groupLabel("skill", false)).toBe("Skills");
    expect(emptyText("skill", false, false)).toBe("No skills found.");
    expect(groupLabel("pull-request", false)).toBe("Pull requests");
    expect(emptyText("pull-request", true, false)).toBe("Loading…");
    expect(groupLabel("slash-command", false)).toBe("Commands");
    expect(emptyText("slash-command", false, false)).toBe("No matching commands.");
  });
});
