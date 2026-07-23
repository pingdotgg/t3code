import { assert, describe, it } from "@effect/vitest";

import { parseGitCloneProgressLine } from "./CloneProgress.ts";

describe("parseGitCloneProgressLine", () => {
  it("parses receiving progress and normalized transfer metrics", () => {
    assert.deepStrictEqual(
      parseGitCloneProgressLine("Receiving objects:  64% (64/100), 18.40 MiB | 4.20 MiB/s"),
      {
        type: "progress",
        stage: "receiving",
        percent: 64,
        completed: 64,
        total: 100,
        receivedBytes: 19_293_798,
        bytesPerSecond: 4_404_019,
      },
    );
  });

  it("maps resolving and checkout output to stable stages", () => {
    assert.deepStrictEqual(parseGitCloneProgressLine("Resolving deltas: 25% (5/20)"), {
      type: "progress",
      stage: "resolving",
      percent: 25,
      completed: 5,
      total: 20,
      receivedBytes: null,
      bytesPerSecond: null,
    });
    assert.deepStrictEqual(parseGitCloneProgressLine("Updating files: 50% (10/20)"), {
      type: "progress",
      stage: "checkout",
      percent: 50,
      completed: 10,
      total: 20,
      receivedBytes: null,
      bytesPerSecond: null,
    });
  });

  it("ignores unrecognized and terminal-controlled output", () => {
    assert.isNull(parseGitCloneProgressLine("remote: repository supplied text"));
    assert.isNull(parseGitCloneProgressLine("remote: Receiving objects: 100% (1/1)"));
    assert.isNull(parseGitCloneProgressLine("\u001B[2JReceiving objects: 50% (1/2)"));
    assert.isNull(parseGitCloneProgressLine("Receiving objects: 101% (101/100)"));
  });
});
