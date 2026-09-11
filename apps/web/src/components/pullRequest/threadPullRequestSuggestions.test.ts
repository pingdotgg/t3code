import { ProjectId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { threadPullRequestSuggestions } from "./threadPullRequestSuggestions";

const identity = { canonicalKey: "github.com/acme/web" };
const url = (number: number) => "https://github.com/acme/web/pull/" + number;
const link = (number: number): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "acme/web",
  number,
  url: url(number),
  source: "manual",
  linkedAt: "2026-09-10T12:00:00Z",
  snapshot: null,
  stack: null,
});

it("finds multiple PRs in thread messages, deduplicates URLs, and excludes other projects and issues", () => {
  const result = threadPullRequestSuggestions(
    { pullRequests: [link(1)] },
    [
      {
        text:
          "[First](" +
          url(1) +
          "/files) <" +
          url(2) +
          "> " +
          url(3) +
          ". https://github.com/acme/other/pull/4 https://github.com/acme/web/issues/5",
      },
      { text: "https://GITHUB.com/ACME/WEB/pull/2?tab=commits" },
    ],
    identity,
  );
  expect(result.map((entry) => entry.url)).toEqual([url(1), url(2), url(3)]);
});

it("keeps known references without thread history or project identity and hides dismissed stack links", () => {
  const result = threadPullRequestSuggestions(
    {
      pullRequests: [link(2), { ...link(3), source: "stack-dismissed" }],
      branchPullRequest: { ...link(1), projectId: ProjectId.make("project") },
    },
    [{ text: url(4) }],
    null,
  );
  expect(result.map((entry) => entry.number)).toEqual([1, 2]);
});

it("recognizes other supported hosts and matches repository aliases", () => {
  const result = threadPullRequestSuggestions(
    { pullRequests: [] },
    [
      {
        text: "https://org.visualstudio.com/project/_git/repo/pullrequest/7 https://dev.azure.com/org/project/_git/repo/pullrequest/7 https://dev.azure.com/other/project/_git/repo/pullrequest/8",
      },
    ],
    { canonicalKey: "dev.azure.com/org/project/_git/repo" },
  );
  expect(result).toHaveLength(1);
  expect(result[0]?.number).toBe(7);
});
