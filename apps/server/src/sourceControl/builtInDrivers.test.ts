import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { IssueTrackerKind, SourceControlProviderKind } from "@t3tools/contracts";
import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
import * as AzureDevOpsPullRequestCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsPullRequestCli";
import * as BitbucketApi from "@t3tools/source-control-bitbucket/server/BitbucketApi";
import * as BitbucketPullRequestApi from "@t3tools/source-control-bitbucket/server/BitbucketPullRequestApi";
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";
import * as GitCafeApi from "@t3tools/source-control-gitcafe/server/GitCafeApi";
import * as GitCafeCredentials from "@t3tools/source-control-gitcafe/server/GitCafeCredentials";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as GitLabPullRequestCli from "@t3tools/source-control-gitlab/server/GitLabPullRequestCli";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { IssueTrackerHost } from "@t3tools/issue-tracker-core/server/IssueTrackerHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";

import * as BuiltInIssueTrackers from "../issue/builtInIssueTrackers.ts";
import * as IssueTrackerRegistry from "../issue/IssueTrackerRegistry.ts";
import * as PullRequestProviderRegistry from "../pullRequest/PullRequestProviderRegistry.ts";
import * as BuiltInDrivers from "./builtInDrivers.ts";

it.effect(
  "builds every registered native port in order and keeps standalone trackers issue-only",
  () =>
    Effect.gen(function* () {
      const hosts = yield* Effect.forEach(
        BuiltInDrivers.BUILT_IN_SOURCE_CONTROL_DRIVERS,
        (driver) => driver.make,
      );
      const pullRequests = yield* PullRequestProviderRegistry.make;
      const issues = yield* Effect.forEach(
        BuiltInIssueTrackers.BUILT_IN_ISSUE_TRACKERS,
        (driver) => driver.make,
      );
      const issueRegistry = yield* IssueTrackerRegistry.makeWithTrackers(issues);
      const hostKinds = ["github", "gitlab", "azure-devops", "bitbucket", "forgejo", "gitcafe"].map(
        (kind) => SourceControlProviderKind.make(kind),
      );
      assert.deepStrictEqual(
        hosts.map((host) => host.sourceControl.kind),
        hostKinds,
      );
      assert.deepStrictEqual(
        hosts.map((host) => host.discovery.kind),
        hostKinds,
      );
      assert.deepStrictEqual(pullRequests.kinds, hostKinds);
      assert.deepStrictEqual(
        issueRegistry.kinds,
        ["github", "gitlab", "azure-devops", "forgejo", "gitcafe", "linear", "jira"].map((kind) =>
          IssueTrackerKind.make(kind),
        ),
      );
      assert.deepStrictEqual(
        issueRegistry.standalone.map((issue) => issue.kind),
        ["linear", "jira"],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          TestSourceControlHost.layer(),
          SourceControlRateLimit.layer,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Unexpected HTTP request")),
          ),
          Layer.mock(IssueTrackerHost)({
            credentials: { get: () => Effect.die("Unexpected credential read") },
          }),
          Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}),
          Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({}),
          Layer.mock(BitbucketApi.BitbucketApi)({}),
          Layer.mock(BitbucketPullRequestApi.BitbucketPullRequestApi)({}),
          Layer.mock(ForgejoCli.ForgejoCli)({}),
          Layer.mock(GitCafeApi.GitCafeApi)({}),
          Layer.mock(GitCafeCredentials.GitCafeCredentials)({}),
          Layer.mock(GitHubRest.GitHubRest)({}),
          Layer.mock(GitHubRequestPolicy.GitHubRequestPolicy)({}),
          Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({}),
          Layer.mock(GitLabCli.GitLabCli)({}),
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({}),
        ),
      ),
    ),
);
