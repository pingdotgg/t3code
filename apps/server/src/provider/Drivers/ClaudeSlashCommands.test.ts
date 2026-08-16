import { describe, expect, it } from "vite-plus/test";

import { retainClaudeSlashCommands } from "./ClaudeSlashCommands.ts";

const review = { name: "review", description: "Review the diff" };
const commit = { name: "commit", description: "Commit changes" };

describe("retainClaudeSlashCommands", () => {
  it("keeps a populated probe result", () => {
    expect(retainClaudeSlashCommands([review, commit], [review], true)).toEqual([review, commit]);
  });

  it("reuses the previous list when a failed probe is empty", () => {
    expect(retainClaudeSlashCommands([], [review, commit], true)).toEqual([review, commit]);
  });

  it("keeps a successful empty probe instead of stale commands", () => {
    expect(retainClaudeSlashCommands([], [review, commit], false)).toEqual([]);
  });

  it("passes through empty when there is no previous list", () => {
    expect(retainClaudeSlashCommands([], [], true)).toEqual([]);
  });
});
