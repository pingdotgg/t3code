import { describe, expect, it } from "vite-plus/test";

import {
  classifyCheckpointPaths,
  formatCheckpointCommitMessage,
  parseCheckpointCommitMessage,
  parseRawDiffEntries,
  type RawDiffEntry,
} from "./CheckpointAttribution.ts";

const ZERO_OID = "0".repeat(40);

function entry(overrides: Partial<RawDiffEntry> & { path: string }): RawDiffEntry {
  return {
    srcMode: "100644",
    dstMode: "100644",
    srcOid: "a".repeat(40),
    dstOid: "b".repeat(40),
    status: "M",
    ...overrides,
  };
}

describe("checkpoint commit message metadata", () => {
  it("round-trips head and branch", () => {
    const message = formatCheckpointCommitMessage({
      checkpointRef: "refs/t3/checkpoints/x/turn/3",
      headOid: "c".repeat(40),
      branch: "feature/attribution",
    });
    expect(parseCheckpointCommitMessage(message)).toEqual({
      headOid: "c".repeat(40),
      branch: "feature/attribution",
    });
  });

  it("round-trips null head (unborn HEAD)", () => {
    const message = formatCheckpointCommitMessage({
      checkpointRef: "refs/t3/checkpoints/x/turn/0",
      headOid: null,
      branch: null,
    });
    expect(parseCheckpointCommitMessage(message)).toEqual({ headOid: null, branch: null });
  });

  it("returns null for legacy messages without metadata", () => {
    expect(parseCheckpointCommitMessage("t3 checkpoint ref=refs/t3/checkpoints/x/turn/1")).toBe(
      null,
    );
  });
});

describe("parseRawDiffEntries", () => {
  it("parses NUL-separated raw records", () => {
    const src = "a".repeat(40);
    const dst = "b".repeat(40);
    const output = `:100644 100644 ${src} ${dst} M\0src/index.ts\0:000000 100644 ${ZERO_OID} ${dst} A\0new file.ts\0`;
    expect(parseRawDiffEntries(output)).toEqual([
      {
        srcMode: "100644",
        dstMode: "100644",
        srcOid: src,
        dstOid: dst,
        status: "M",
        path: "src/index.ts",
      },
      {
        srcMode: "000000",
        dstMode: "100644",
        srcOid: ZERO_OID,
        dstOid: dst,
        status: "A",
        path: "new file.ts",
      },
    ]);
  });

  it("returns empty for empty output", () => {
    expect(parseRawDiffEntries("")).toEqual([]);
  });
});

describe("classifyCheckpointPaths", () => {
  it("attributes a pull-only change to git", () => {
    const pulled = entry({ path: "upstream.ts" });
    const origins = classifyCheckpointPaths({
      treeDelta: [pulled],
      historyDelta: [pulled],
      turnAuthoredPaths: new Set(),
    });
    expect(origins.get("upstream.ts")).toBe("git");
  });

  it("attributes tool edits to agent (no history match)", () => {
    const origins = classifyCheckpointPaths({
      treeDelta: [entry({ path: "edited.ts" })],
      historyDelta: [],
      turnAuthoredPaths: new Set(),
    });
    expect(origins.get("edited.ts")).toBe("agent");
  });

  it("keeps a file the agent committed during the turn as agent work", () => {
    const committed = entry({ path: "committed.ts" });
    const origins = classifyCheckpointPaths({
      treeDelta: [committed],
      historyDelta: [committed],
      turnAuthoredPaths: new Set(["committed.ts"]),
    });
    expect(origins.get("committed.ts")).toBe("agent");
  });

  it("attributes a pulled-then-edited file to agent (blob transition differs)", () => {
    const origins = classifyCheckpointPaths({
      treeDelta: [entry({ path: "both.ts", dstOid: "d".repeat(40) })],
      historyDelta: [entry({ path: "both.ts", dstOid: "e".repeat(40) })],
      turnAuthoredPaths: new Set(),
    });
    expect(origins.get("both.ts")).toBe("agent");
  });

  it("attributes mode-only mismatches to agent", () => {
    const origins = classifyCheckpointPaths({
      treeDelta: [entry({ path: "script.sh", dstMode: "100755" })],
      historyDelta: [entry({ path: "script.sh", dstMode: "100644" })],
      turnAuthoredPaths: new Set(),
    });
    expect(origins.get("script.sh")).toBe("agent");
  });

  it("attributes checkout deletions and additions to git", () => {
    const removed = entry({
      path: "only-on-old-branch.ts",
      dstMode: "000000",
      dstOid: ZERO_OID,
      status: "D",
    });
    const added = entry({
      path: "only-on-new-branch.ts",
      srcMode: "000000",
      srcOid: ZERO_OID,
      status: "A",
    });
    const origins = classifyCheckpointPaths({
      treeDelta: [removed, added],
      historyDelta: [removed, added],
      turnAuthoredPaths: new Set(),
    });
    expect(origins.get("only-on-old-branch.ts")).toBe("git");
    expect(origins.get("only-on-new-branch.ts")).toBe("git");
  });
});
