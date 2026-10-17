import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const grokInstanceId = ProviderInstanceId.make("grok");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const layerTest = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Project",
            workspaceRoot: "/project-root",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
  ),
);

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("uses the project root for local-checkout threads", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-root");
    }),
  );

  it.effect("prefers a provisioned worktree over the project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
    }),
  );

  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );
});

const tokenReads: Array<string | null | undefined> = [];
const identityFor = (owner: string) => ({
  canonicalKey: `github.com/${owner}/web`,
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: `git@github.com:${owner}/web.git`,
  },
  owner,
  name: "web",
});

// The company's repository has an account rule; the personal one is left to gh.
const layerWithAccounts = layerTest.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: (cwd) =>
          Effect.succeed(identityFor(cwd === "/project-worktree" ? "acme" : "someone")),
      }),
      Layer.mock(GitHubCredentials.GitHubCredentials)({
        accountFor: (_host, repository) =>
          Effect.succeed(repository === "acme/web" ? "work" : undefined),
        get: (host, repository) =>
          Effect.sync(() => {
            tokenReads.push(repository);
            return {
              host,
              token: Redacted.make("work-token"),
              source: "gh" as const,
              fingerprint: "fingerprint",
              account: "work",
            };
          }),
      }),
    ),
  ),
);

it.layer(layerWithAccounts)("RuntimePolicyV2 with GitHub accounts", (it) => {
  it.effect("hands the agent the token of the account its repository reads as", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const company = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.deepEqual(ProviderAdapter.runtimePolicyEnvironment(company), {
        GH_TOKEN: "work-token",
      });
      // The token never shows in a policy that is logged or used as a key.
      assert.notInclude(JSON.stringify(company), "work-token");

      const personal = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.isUndefined(personal.environment);
      // A workspace no rule covers never asks gh for a token.
      assert.deepEqual(tokenReads, ["acme/web"]);
    }),
  );
});
