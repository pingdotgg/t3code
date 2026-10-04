import { assert, it } from "vite-plus/test";

import { parseGitRemoteVerbose } from "./remoteRefs.ts";

const url = "https://github.com/pingdotgg/t3code";

it("reads fetch and push lines from git remote -v", () => {
  assert.deepStrictEqual(
    parseGitRemoteVerbose(
      `origin\t${url} (fetch)\norigin\t${url} (push)\nfork\tgit@github.com:me/t3code.git (fetch)\n`,
    ),
    [
      { name: "origin", url, direction: "fetch" },
      { name: "origin", url, direction: "push" },
      { name: "fork", url: "git@github.com:me/t3code.git", direction: "fetch" },
    ],
  );
});

it("reads a partial-clone fetch line that carries its filter", () => {
  assert.deepStrictEqual(
    parseGitRemoteVerbose(`origin\t${url} (fetch) [blob:none]\norigin\t${url} (push)\n`),
    [
      { name: "origin", url, direction: "fetch" },
      { name: "origin", url, direction: "push" },
    ],
  );
  assert.deepStrictEqual(parseGitRemoteVerbose(`origin\t${url} (fetch) [tree:0]`), [
    { name: "origin", url, direction: "fetch" },
  ]);
  assert.deepStrictEqual(parseGitRemoteVerbose(`origin\t${url} (fetch) [blob:none] [tree:0]`), [
    { name: "origin", url, direction: "fetch" },
  ]);
});

it("tolerates CRLF line endings and blank lines", () => {
  assert.deepStrictEqual(
    parseGitRemoteVerbose(
      `\r\norigin\t${url} (fetch) [blob:none]\r\n\r\norigin\t${url} (push)\r\n`,
    ),
    [
      { name: "origin", url, direction: "fetch" },
      { name: "origin", url, direction: "push" },
    ],
  );
});

it("skips lines that are not remote entries", () => {
  assert.deepStrictEqual(
    parseGitRemoteVerbose(
      [
        "origin",
        `origin\t${url}`,
        `origin\t${url} (pull)`,
        `origin\t${url} (fetch) trailing`,
        `origin\t${url} (fetch) [blob:none`,
        `origin\t${url} (push)`,
      ].join("\n"),
    ),
    [{ name: "origin", url, direction: "push" }],
  );
});
