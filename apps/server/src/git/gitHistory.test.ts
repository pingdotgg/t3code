import { describe, expect, it } from "vite-plus/test";

import { parseGitHistoryLog } from "./gitHistory.ts";

const record = (fields: string[]) => `${fields.join("\0")}\x1e\n`;

describe("parseGitHistoryLog", () => {
  it("reads commits, parents, HEAD and typed refs from decorate=full output", () => {
    const text =
      record([
        "a".repeat(40),
        "aaaaaaa",
        `${"b".repeat(40)} ${"c".repeat(40)}`,
        "Ada",
        "1760000000",
        "HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0",
        "Merge branch 'feature'",
      ]) + record(["b".repeat(40), "bbbbbbb", "", "Linus", "1750000000", "", "root, with comma"]);

    expect(parseGitHistoryLog(text)).toEqual([
      {
        sha: "a".repeat(40),
        shortSha: "aaaaaaa",
        parents: ["b".repeat(40), "c".repeat(40)],
        author: "Ada",
        timestamp: 1760000000,
        subject: "Merge branch 'feature'",
        refs: [
          { name: "main", kind: "local" },
          { name: "origin/main", kind: "remote" },
          { name: "v1.0", kind: "tag" },
        ],
        head: true,
      },
      {
        sha: "b".repeat(40),
        shortSha: "bbbbbbb",
        parents: [],
        author: "Linus",
        timestamp: 1750000000,
        subject: "root, with comma",
        refs: [],
        head: false,
      },
    ]);
  });

  it("marks a detached HEAD and ignores empty or truncated records", () => {
    const text = `${record(["d".repeat(40), "ddddddd", "", "Grace", "1", "HEAD", "detached"])}partial\0record`;
    const commits = parseGitHistoryLog(text);
    expect(commits.map((commit) => [commit.sha, commit.head, commit.refs])).toEqual([
      ["d".repeat(40), true, []],
    ]);
  });
});
