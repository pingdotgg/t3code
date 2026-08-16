import { assert, it } from "@effect/vitest";

import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import { azureDevOpsProviderFailure } from "./AzureDevOpsPullRequestProvider.ts";
import { bitbucketProviderFailure } from "./BitbucketPullRequestProvider.ts";
import { gitHubProviderFailure } from "./GitHubPullRequestProvider.ts";
import { gitLabProviderFailure } from "./GitLabPullRequestProvider.ts";

const cause = new Error("redacted provider failure");

it("classifies rate limits from every pull-request provider", () => {
  assert.deepStrictEqual(
    gitHubProviderFailure(
      new GitHubCli.GitHubCliRateLimitError({ command: "gh", cwd: "/repo", cause }),
    ),
    { reason: "rate-limited" },
  );
  assert.deepStrictEqual(
    gitLabProviderFailure(
      new GitLabCli.GitLabCliRateLimitError({
        operation: "execute",
        command: "glab",
        cwd: "/repo",
        cause,
      }),
    ),
    { reason: "rate-limited" },
  );
  assert.deepStrictEqual(
    azureDevOpsProviderFailure(
      new AzureDevOpsCli.AzureDevOpsCliRateLimitError({
        operation: "execute",
        command: "az",
        cwd: "/repo",
        argumentCount: 1,
        cause,
      }),
    ),
    { reason: "rate-limited" },
  );
  assert.deepStrictEqual(
    bitbucketProviderFailure(
      new BitbucketApi.BitbucketResponseError({
        operation: "request",
        status: 429,
        responseBodyLength: 0,
        retryAt: 120_000,
      }),
    ),
    { reason: "rate-limited", retryAt: 120_000 },
  );
});

it("keeps GitHub's exact retry time", () => {
  assert.deepStrictEqual(
    gitHubProviderFailure(
      new SourceControlRateLimit.SourceControlRateLimitPausedError({
        provider: "github",
        host: "github.com",
        retryAt: 1_786_802_400_000,
      }),
    ),
    { reason: "rate-limited", retryAt: 1_786_802_400_000 },
  );
});
