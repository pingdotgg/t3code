import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  decodeOriginPullRequestJson,
  decodeOriginPullRequestListJson,
  originNameWithOwnerFromGitUrl,
  originWebRepositoryUrl,
} from "./originPullRequests.ts";

describe("decodeOriginPullRequestJson", () => {
  it("accepts Origin CLI field names and numeric strings", () => {
    const decoded = decodeOriginPullRequestJson(
      JSON.stringify({
        number: "13",
        title: "Add Origin provider",
        url: "https://cursor.com/codebase/acme/checkout/pull/13",
        status: "open",
        head: { ref: "refs/heads/feature/origin" },
        base: { ref: "main" },
        updatedAt: "2026-08-17T00:00:00.000Z",
      }),
    );

    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    expect(decoded.success.number).toBe(13);
    expect(decoded.success.headRefName).toBe("feature/origin");
    expect(decoded.success.baseRefName).toBe("main");
    expect(decoded.success.state).toBe("open");
    expect(Option.isSome(decoded.success.updatedAt)).toBe(true);
  });

  it("treats merged closed pull requests as merged", () => {
    const decoded = decodeOriginPullRequestJson(
      JSON.stringify({
        number: 4,
        title: "Landed",
        url: "https://cursor.com/codebase/acme/checkout/pull/4",
        state: "closed",
        merged: true,
        head: "feature/landed",
        base: "main",
      }),
    );

    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    expect(decoded.success.state).toBe("merged");
    expect(decoded.success.headRefName).toBe("feature/landed");
  });
});

describe("decodeOriginPullRequestListJson", () => {
  it("skips malformed rows instead of failing the list", () => {
    const decoded = decodeOriginPullRequestListJson(
      JSON.stringify([
        {
          number: 1,
          title: "Ready",
          url: "https://cursor.com/codebase/acme/checkout/pull/1",
          status: "open",
          head: "feature/ready",
          base: "main",
        },
        { title: "Missing number" },
      ]),
    );

    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    expect(decoded.success).toHaveLength(1);
    expect(decoded.success[0]?.number).toBe(1);
  });

  it("rebuilds Origin web URLs from the repository identity when url is omitted", () => {
    const decoded = decodeOriginPullRequestListJson(
      JSON.stringify([
        {
          number: 13,
          title: "Missing url",
          status: "open",
          head: "feature/origin",
          base: "main",
        },
      ]),
      { nameWithOwner: "acme/checkout" },
    );

    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    expect(decoded.success[0]?.url).toBe("https://cursor.com/codebase/acme/checkout/pull/13");
  });

  it("rebuilds Origin web URLs from JSON org and name", () => {
    const decoded = decodeOriginPullRequestJson(
      JSON.stringify({
        number: 4,
        title: "From org fields",
        status: "open",
        head: "feature/org",
        base: "main",
        org: "acme",
        name: "checkout",
      }),
    );

    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    expect(decoded.success.url).toBe("https://cursor.com/codebase/acme/checkout/pull/4");
  });

  it("drops rows that cannot form a valid Origin pull request URL", () => {
    const decoded = decodeOriginPullRequestListJson(
      JSON.stringify([
        {
          number: 13,
          title: "Missing url and repo",
          status: "open",
          head: "feature/origin",
          base: "main",
        },
      ]),
    );

    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    expect(decoded.success).toHaveLength(0);
  });
});

describe("originNameWithOwnerFromGitUrl", () => {
  it("reads owner and repo from Origin clone URLs", () => {
    expect(originNameWithOwnerFromGitUrl("git@origin.cursor.com:acme/checkout.git")).toBe(
      "acme/checkout",
    );
    expect(originNameWithOwnerFromGitUrl("https://origin.cursor.com/acme/checkout.git")).toBe(
      "acme/checkout",
    );
  });
});

describe("originWebRepositoryUrl", () => {
  it("builds the Origin codebase page, not the git host", () => {
    expect(originWebRepositoryUrl("acme/checkout")).toBe(
      "https://cursor.com/codebase/acme/checkout",
    );
  });
});
