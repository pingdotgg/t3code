import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as GitHub from "./GitHubPullRequestProvider.ts";
import * as GitLab from "./GitLabPullRequestProvider.ts";
import * as Bitbucket from "./BitbucketPullRequestProvider.ts";
import * as Azure from "./AzureDevOpsPullRequestProvider.ts";
import * as GitHubCli from "./GitHubPullRequestCli.ts";
import * as GitLabCli from "./GitLabPullRequestCli.ts";
import * as BitbucketApi from "./BitbucketPullRequestApi.ts";
import * as AzureCli from "./AzureDevOpsPullRequestCli.ts";
import {
  assertSourceBranchDeletable,
  decodeBranchDeletionJson,
} from "./pullRequestBranchDeletion.ts";

it.effect("allows only finished pull requests and refuses both protected branch identities", () =>
  Effect.gen(function* () {
    const input = {
      state: "merged",
      sourceRepository: "42",
      baseRepository: "42",
      sourceBranch: "feat/change",
      baseBranch: "release",
      defaultBranch: "main",
    };
    yield* assertSourceBranchDeletable(input);
    yield* assertSourceBranchDeletable({ ...input, state: "closed" });
    yield* assertSourceBranchDeletable({ ...input, state: "SUPERSEDED" });
    for (const state of ["open", "active", "unknown"]) {
      const error = yield* Effect.flip(assertSourceBranchDeletable({ ...input, state }));
      expect(error.reason).toBe("not-finished");
    }
    for (const sourceBranch of ["main", "release"]) {
      const error = yield* Effect.flip(assertSourceBranchDeletable({ ...input, sourceBranch }));
      expect(error.reason).toBe("protected-branch");
    }
  }),
);

it.effect("distinguishes the upstream target from a same-named fork branch", () =>
  Effect.gen(function* () {
    const input = {
      state: "closed",
      sourceRepository: "fork",
      baseRepository: "upstream",
      sourceBranch: "main",
      baseBranch: "main",
      defaultBranch: "develop",
    };
    yield* assertSourceBranchDeletable(input);
    for (const overrides of [{ baseRepository: "fork" }, { defaultBranch: "main" }]) {
      const error = yield* Effect.flip(assertSourceBranchDeletable({ ...input, ...overrides }));
      expect(error.reason).toBe("protected-branch");
    }
  }),
);

it.effect("keeps the branch response decode failure as the structured error cause", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      decodeBranchDeletionJson(Schema.Struct({ branch: Schema.String }), '{"branch":1}'),
    );
    expect(error.reason).toBe("invalid-response");
    expect(error.cause).toBeDefined();
  }),
);

it.effect(
  "advertises branch deletion without adding an unknown action to legacy capability arrays",
  () =>
    Effect.gen(function* () {
      const providers = yield* Effect.all([GitHub.make, GitLab.make, Bitbucket.make, Azure.make]);
      const legacyCapabilities = Schema.Struct({
        actions: Schema.Array(
          Schema.Literals([
            "merge",
            "ready",
            "draft",
            "close",
            "reopen",
            "update-branch",
            "enable-auto-merge",
            "disable-auto-merge",
            "revert",
            "approve-workflows",
          ]),
        ),
      });
      for (const provider of providers) {
        expect(provider.capabilities.deleteSourceBranch).toBe(true);
        yield* Schema.decodeUnknownEffect(legacyCapabilities)(provider.capabilities);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(GitHubCli.GitHubPullRequestCli)({}),
          Layer.mock(GitLabCli.GitLabPullRequestCli)({}),
          Layer.mock(BitbucketApi.BitbucketPullRequestApi)({}),
          Layer.mock(AzureCli.AzureDevOpsPullRequestCli)({}),
        ),
      ),
    ),
);
