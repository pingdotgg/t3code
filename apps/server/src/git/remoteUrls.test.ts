import { describe, expect, it } from "@effect/vitest";

import { parseGitRemoteVerboseOutput, parseRemoteFetchUrls } from "./remoteUrls.ts";

describe("git remote -v parsing", () => {
  for (const newline of ["\n", "\r\n"]) {
    it(`preserves ordinary and partial-clone URLs with ${JSON.stringify(newline)} line endings`, () => {
      const cases = [
        ["https://github.com/team/repo.git", ""],
        ["git@github.com:team/repo.git", " [blob:none]"],
        ["ssh://git@github.com/team/repo.git", " [blob:limit=1024]"],
        ["https://org.visualstudio.com/DefaultCollection/Project/_git/repo", " [blob:none]"],
        ["https://dev.azure.com/org/Project/_git/repo", ""],
        ["git@ssh.dev.azure.com:v3/org/Project/repo", " [tree:0]"],
      ];
      const output = cases
        .flatMap(([url, annotation], index) => [
          `remote${index}\t${url} (fetch)${annotation}`,
          `remote${index}\t${url} (push)`,
        ])
        .join(newline);

      expect(parseGitRemoteVerboseOutput(output)).toEqual(
        new Map(cases.map(([url], index) => [`remote${index}`, { url, pushUrl: url }])),
      );
    });
  }

  it("keeps fetch and push URLs separate and excludes push-only remotes from fetch discovery", () => {
    const output = [
      "origin git@github.com:contributor/repo.git (push)",
      "origin https://github.com/team/repo.git (fetch) [blob:none]",
      "upstream https://github.com/upstream/repo.git (fetch)",
      "publish git@github.com:publish/repo.git (push)",
    ].join("\n");

    expect(parseGitRemoteVerboseOutput(output)).toEqual(
      new Map([
        [
          "origin",
          {
            url: "https://github.com/team/repo.git",
            pushUrl: "git@github.com:contributor/repo.git",
          },
        ],
        ["upstream", { url: "https://github.com/upstream/repo.git" }],
        ["publish", { pushUrl: "git@github.com:publish/repo.git" }],
      ]),
    );
    expect(parseRemoteFetchUrls(output)).toEqual(
      new Map([
        ["origin", "https://github.com/team/repo.git"],
        ["upstream", "https://github.com/upstream/repo.git"],
      ]),
    );
  });

  it("ignores blank and malformed lines without losing valid remotes", () => {
    expect(
      parseRemoteFetchUrls(
        [
          "",
          "unclosed https://github.com/team/repo.git (fetch) [blob:none",
          "invalid-direction https://github.com/team/repo.git (other)",
          "unexpected-suffix https://github.com/team/repo.git (fetch) unexpected",
          "\torigin\thttps://github.com/team/repo.git (fetch) [tree:0]\t",
          " ",
        ].join("\n"),
      ),
    ).toEqual(new Map([["origin", "https://github.com/team/repo.git"]]));
  });
});
