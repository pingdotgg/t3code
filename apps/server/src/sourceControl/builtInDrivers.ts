/**
 * The source control drivers this build ships with. Both registries, repository operations and
 * pull requests, iterate this list; a host with no driver here shows up as unsupported.
 *
 * Adding a host means writing its `@t3tools/source-control-<host>` package, adding its driver
 * here, and providing its services' layers in `layer` below.
 *
 * @module sourceControl/builtInDrivers
 */
import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
import * as AzureDevOpsPullRequestCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsPullRequestCli";
import * as AzureDevOpsDriver from "@t3tools/source-control-azure-devops/server/driver";
import * as BitbucketApi from "@t3tools/source-control-bitbucket/server/BitbucketApi";
import * as BitbucketPullRequestApi from "@t3tools/source-control-bitbucket/server/BitbucketPullRequestApi";
import * as BitbucketDriver from "@t3tools/source-control-bitbucket/server/driver";
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";
import * as ForgejoDriver from "@t3tools/source-control-forgejo/server/driver";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as GitHubDriver from "@t3tools/source-control-github/server/driver";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as GitLabPullRequestCli from "@t3tools/source-control-gitlab/server/GitLabPullRequestCli";
import * as GitLabDriver from "@t3tools/source-control-gitlab/server/driver";
import type { SourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Layer from "effect/Layer";

import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

const drivers = [
  GitHubDriver.driver,
  GitLabDriver.driver,
  AzureDevOpsDriver.driver,
  BitbucketDriver.driver,
  ForgejoDriver.driver,
];

/** Every service a built-in driver's `make` needs; the server's layers must provide them all. */
export type BuiltInSourceControlDriversEnv =
  (typeof drivers)[number] extends SourceControlDriver<infer R> ? R : never;

/** Ordered as the hosts appear in discovery. */
export const BUILT_IN_SOURCE_CONTROL_DRIVERS: ReadonlyArray<
  SourceControlDriver<BuiltInSourceControlDriversEnv>
> = drivers;

/** The services the built-in drivers' packages own, plus the host port they all run against. */
export const layer = Layer.mergeAll(
  // `GitHubApi.layerWithDependencies` carries the quota reserve and rate-limit pause every GitHub
  // reader shares, so the server builds it once, here.
  GitHubPullRequestApi.layer.pipe(Layer.provideMerge(GitHubApi.layerWithDependencies)),
  AzureDevOpsPullRequestCli.layer.pipe(Layer.provideMerge(AzureDevOpsCli.layer)),
  BitbucketPullRequestApi.layer.pipe(Layer.provideMerge(BitbucketApi.layer)),
  ForgejoCli.layer,
  GitLabPullRequestCli.layer.pipe(Layer.provideMerge(GitLabCli.layer)),
).pipe(Layer.provideMerge(ServerSourceControlHost.layer));
