import { describe, expect, it } from "vitest";

import { extractGitHubPullRequests } from "./prDiscovery.ts";

describe("extractGitHubPullRequests", () => {
  it("extracts and normalizes GitHub pull request URLs from assistant messages", () => {
    expect(
      extractGitHubPullRequests(
        [
          "Opened PR: https://github.com/acme/app/pull/42",
          "Duplicate markdown link: <https://github.com/acme/app/pull/42>",
          "Other repo: https://github.com/acme/api/pull/7.",
        ].join("\n"),
      ),
    ).toEqual([
      {
        owner: "acme",
        repo: "app",
        number: 42,
        url: "https://github.com/acme/app/pull/42",
        externalId: "acme/app#42",
      },
      {
        owner: "acme",
        repo: "api",
        number: 7,
        url: "https://github.com/acme/api/pull/7",
        externalId: "acme/api#7",
      },
    ]);
  });
});
