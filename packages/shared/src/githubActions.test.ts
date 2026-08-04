import { describe, expect, it } from "vite-plus/test";
import { isGitHubPrChecksCommand, parseGitHubActionsSnapshot } from "./githubActions.ts";

describe("GitHub Actions snapshots", () => {
  it("recognizes direct and shell-wrapped PR check commands", () => {
    expect(isGitHubPrChecksCommand("gh pr checks 42 --watch")).toBe(true);
    expect(isGitHubPrChecksCommand(["/bin/zsh", "-lc", "gh pr checks --watch"])).toBe(true);
    expect(isGitHubPrChecksCommand("gh run list")).toBe(false);
  });

  it("parses and deduplicates the latest watched table", () => {
    const snapshot = parseGitHubActionsSnapshot({
      command: "gh pr checks 42 --watch",
      output: [
        "Test\tpending\t0\thttps://github.com/acme/repo/actions/runs/1",
        "Lint\tpass\t12s\thttps://github.com/acme/repo/actions/runs/2",
        "Test\tpass\t1m2s\thttps://github.com/acme/repo/actions/runs/1",
      ].join("\n"),
    });

    expect(snapshot).toEqual({
      kind: "pr-checks",
      watching: true,
      checks: [
        {
          name: "Lint",
          bucket: "pass",
          duration: "12s",
          link: "https://github.com/acme/repo/actions/runs/2",
        },
        {
          name: "Test",
          bucket: "pass",
          duration: "1m2s",
          link: "https://github.com/acme/repo/actions/runs/1",
        },
      ],
    });
  });

  it("parses gh JSON output", () => {
    const snapshot = parseGitHubActionsSnapshot({
      command: "gh pr checks --json bucket,name,link,workflow",
      output: JSON.stringify([
        {
          bucket: "pending",
          name: "Test",
          link: "https://github.com/acme/repo/actions/runs/1",
          workflow: "CI",
        },
      ]),
    });

    expect(snapshot?.checks).toEqual([
      {
        name: "Test",
        bucket: "pending",
        link: "https://github.com/acme/repo/actions/runs/1",
        workflow: "CI",
      },
    ]);
  });
});
