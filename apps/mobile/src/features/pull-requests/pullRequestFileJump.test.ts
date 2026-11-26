import { describe, expect, it } from "vite-plus/test";
import { requestPullRequestFileJump, subscribePullRequestFileJump } from "./pullRequestFileJump";

describe("pull request file jumps", () => {
  it("delivers a pick only to the file diff the sheet returns to, every time it is made", () => {
    const earlier: string[] = [];
    const nearest: string[] = [];
    const stopEarlier = subscribePullRequestFileJump("file-1", (path) => earlier.push(path));
    const stopNearest = subscribePullRequestFileJump("file-2", (path) => nearest.push(path));
    const routes = [
      { key: "pr", name: "PullRequest" },
      { key: "file-1", name: "PullRequestFile" },
      { key: "discussion", name: "PullRequestDiscussion" },
      { key: "file-2", name: "PullRequestFile" },
      { key: "files", name: "PullRequestFiles" },
    ];
    requestPullRequestFileJump(routes, "src/x.ts");
    requestPullRequestFileJump(routes, "src/x.ts");
    stopNearest();
    requestPullRequestFileJump(routes, "src/y.ts");
    stopEarlier();
    expect(nearest).toEqual(["src/x.ts", "src/x.ts"]);
    expect(earlier).toEqual([]);
  });
});
