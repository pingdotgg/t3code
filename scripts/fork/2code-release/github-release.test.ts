import { assert, describe, it } from "@effect/vitest";

import {
  decideEmptyDraftRetarget,
  findReleaseInPaginatedListing,
  githubReleaseAssetNames,
} from "./github-release.ts";

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

  it("finds an untagged draft in a later page of the releases listing", () => {
    assert.deepStrictEqual(
      findReleaseInPaginatedListing(
        JSON.stringify([
          [
            {
              id: 1,
              draft: false,
              tag_name: "other",
              target_commitish: "other-commit",
              assets: [],
            },
          ],
          [
            {
              id: 2,
              draft: true,
              tag_name: "2code-v1.0.108",
              target_commitish: "release-commit",
              assets: [],
            },
          ],
        ]),
        "2code-v1.0.108",
      ),
      {
        id: 2,
        draft: true,
        tagName: "2code-v1.0.108",
        targetCommitish: "release-commit",
        assets: [],
      },
    );
  });

  it("allows retargeting only an empty draft", () => {
    assert.strictEqual(
      decideEmptyDraftRetarget(
        {
          id: 2,
          draft: true,
          tagName: "2code-v1.0.108",
          targetCommitish: "old-commit",
          assets: [],
        },
        "new-commit",
      ),
      "retarget",
    );
    assert.strictEqual(
      decideEmptyDraftRetarget(
        {
          id: 2,
          draft: true,
          tagName: "2code-v1.0.108",
          targetCommitish: "new-commit",
          assets: [],
        },
        "new-commit",
      ),
      "keep",
    );
  });

  it("refuses to retarget a draft that already contains assets", () => {
    assert.throws(
      () =>
        decideEmptyDraftRetarget(
          {
            id: 2,
            draft: true,
            tagName: "2code-v1.0.108",
            targetCommitish: "old-commit",
            assets: [{ name: "candidate.zip", url: "https://api.github.test/assets/1" }],
          },
          "new-commit",
        ),
      /already contains assets; refusing retarget/,
    );
  });

  it("refuses to retarget a published release", () => {
    assert.throws(
      () =>
        decideEmptyDraftRetarget(
          {
            id: 2,
            draft: false,
            tagName: "2code-v1.0.108",
            targetCommitish: "old-commit",
            assets: [],
          },
          "new-commit",
        ),
      /Published release .* refusing retarget/,
    );
  });
});
