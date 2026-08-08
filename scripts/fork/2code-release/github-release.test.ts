import { assert, describe, it } from "@effect/vitest";

import { githubReleaseAssetNames } from "./github-release.ts";

describe("2code GitHub release", () => {
  it("publishes exactly one manifest plus each verified payload", () => {
    assert.deepStrictEqual(
      githubReleaseAssetNames({
        schemaVersion: 1,
        version: "1.0.108",
        tag: "2code-v1.0.108",
        sourceCommit: "abc",
        configSha256: "config",
        manifestName: "latest-mac.yml",
        manifestSha512: "manifest",
        stagingPercentage: 100,
        payloads: [
          {
            localName: "2code-1.0.108-arm64-mac.zip",
            remotePath: "objects/hash/2code-1.0.108-arm64-mac.zip",
            sha512: "zip",
            size: 1,
            contentType: "application/zip",
          },
          {
            localName: "2code-1.0.108-arm64-mac.zip.blockmap",
            remotePath: "objects/hash/2code-1.0.108-arm64-mac.zip.blockmap",
            sha512: "map",
            size: 1,
            contentType: "application/octet-stream",
          },
        ],
      }),
      [
        "2code-1.0.108-arm64-mac.zip",
        "2code-1.0.108-arm64-mac.zip.blockmap",
        "2code-release-plan.json",
        "latest-mac.yml",
      ],
    );
  });
});
