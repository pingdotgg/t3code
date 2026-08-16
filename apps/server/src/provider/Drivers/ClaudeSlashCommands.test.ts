import { describe, expect, it } from "vite-plus/test";

import { retainClaudeSlashCommands } from "./ClaudeSlashCommands.ts";

const review = { name: "review", description: "Review the diff" };
const commit = { name: "commit", description: "Commit changes" };

describe("retainClaudeSlashCommands", () => {
  it("keeps a populated probe result", () => {
    expect(retainClaudeSlashCommands([review, commit], [review])).toEqual([review, commit]);
  });

  it("reuses the previous list when the probe is empty", () => {
    expect(retainClaudeSlashCommands([], [review, commit])).toEqual([review, commit]);
  });

  it("passes through empty when there is no previous list", () => {
    expect(retainClaudeSlashCommands([], [])).toEqual([]);
  });
});
