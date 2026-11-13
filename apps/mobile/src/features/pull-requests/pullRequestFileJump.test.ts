import { describe, expect, it } from "vite-plus/test";
import { requestPullRequestFileJump, subscribePullRequestFileJump } from "./pullRequestFileJump";

describe("pull request file jumps", () => {
  it("delivers a pick to the screens of its scope, every time it is made", () => {
    const seen: string[] = [];
    const other: string[] = [];
    const stop = subscribePullRequestFileJump("a", (path) => seen.push(path));
    const stopOther = subscribePullRequestFileJump("b", (path) => other.push(path));
    requestPullRequestFileJump("a", "src/x.ts");
    requestPullRequestFileJump("a", "src/x.ts");
    stop();
    requestPullRequestFileJump("a", "src/y.ts");
    stopOther();
    expect(seen).toEqual(["src/x.ts", "src/x.ts"]);
    expect(other).toEqual([]);
  });
});
