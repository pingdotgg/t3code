import { describe, expect, it } from "vite-plus/test";
import { relatedPullRequests } from "./pullRequestRelated.logic";

describe("relatedPullRequests", () => {
  it("finds links for each host and excludes the current request and duplicate anchors", () => {
    const urls = [
      "https://github.com/team/repo/pull/2",
      "https://gitlab.com/team/repo/-/merge_requests/3",
      "https://bitbucket.org/team/repo/pull-requests/4",
      "https://dev.azure.com/team/project/_git/repo/pullrequest/5",
    ];
    const own = "https://github.com/team/repo/pull/1";
    expect(
      relatedPullRequests({
        url: own,
        body: [own, ...urls, urls[0] + "#discussion"].join(" "),
        comments: [],
        timelineEvents: [],
      }).map((entry) => entry.url),
    ).toEqual(urls);
  });

  it("uses the native title and state when the timeline enriches a mentioned URL", () => {
    const reference = {
      title: "Fix [thread] replies",
      url: "https://github.com/team/repo/pull/2",
      state: "merged" as const,
    };
    expect(
      relatedPullRequests({
        url: "https://github.com/team/repo/pull/1",
        body: reference.url,
        comments: [],
        timelineEvents: [
          {
            id: "mention",
            kind: "cross-referenced",
            body: "",
            actor: null,
            createdAt: "2026-09-05T00:00:00Z",
            url: null,
            relatedPullRequest: reference,
          },
        ],
      }),
    ).toEqual([reference]);
  });
});
