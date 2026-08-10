import { describe, expect, it } from "vite-plus/test";

import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import {
  bitbucketErrorReason,
  bitbucketViewerPermissions,
} from "./BitbucketPullRequestProvider.ts";

describe("bitbucketErrorReason", () => {
  it("treats only an HTTP 401 as unusable credentials", () => {
    const responseError = (status: number) =>
      new BitbucketApi.BitbucketResponseError({
        operation: "request",
        status,
        responseBodyLength: 0,
      });

    expect(bitbucketErrorReason(responseError(401))).toBe("unauthenticated");
    expect(bitbucketErrorReason(responseError(403))).toBe("failed");
  });
});

describe("bitbucketViewerPermissions", () => {
  it("offers both actions to credentials with write access", () => {
    expect(bitbucketViewerPermissions({ canWrite: true })).toEqual({
      actions: ["merge", "close"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
      // Bitbucket says nothing about who may set a reviewer, and an unreported permission is
      // granted.
      requestReviewers: true,
    });
  });

  it("keeps merge from credentials that can only read the repository", () => {
    expect(bitbucketViewerPermissions({ canWrite: false })).toEqual({
      actions: ["close"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
      requestReviewers: true,
    });
  });

  it("treats an author with read access as any other reader, which is all Bitbucket says", () => {
    // The repository permission is the whole of what Bitbucket reports per account; it says
    // nothing about who opened this pull request, and its author may decline it with read access
    // alone — so declining stays offered rather than being taken from them.
    expect(bitbucketViewerPermissions({ canWrite: false }).actions).toEqual(["close"]);
  });
});
