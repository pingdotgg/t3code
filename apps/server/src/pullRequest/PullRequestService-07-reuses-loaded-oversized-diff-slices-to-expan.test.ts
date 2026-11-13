import { SourceControlProviderKind } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { assert, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type {
  OrchestrationProjectShell,
  ProjectId,
  PullRequestReviewCapabilities,
  PullRequestReviewerCapabilities,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import type { ServerSettings } from "@t3tools/contracts";
import * as ServerSettingsService from "../serverSettings.ts";
import { PullRequestOperationError } from "@t3tools/contracts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import type { SourceControlProvider } from "@t3tools/source-control-core/server/SourceControlProvider";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { fakePullRequestProvider } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import * as PullRequestService from "./PullRequestService.ts";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";

import { project, makeService } from "./PullRequestService-fixtures.testkit.ts";

it.effect(
  "reuses loaded oversized diff slices to expand only files the change request changes",
  () =>
    Effect.gen(function* () {
      const read: Array<string> = [];
      const diffReads: Array<string | undefined> = [];
      const service = yield* makeService({
        projects: [
          project({
            id: "p1",
            title: "t3code",
            workspaceRoot: "/a",
            repository: "pingdotgg/t3code",
          }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            getDiff: (input) =>
              Effect.sync(() => {
                diffReads.push(input.cursor);
                return input.cursor === undefined
                  ? {
                      patch: [
                        "diff --git a/src/old.ts b/src/new.ts",
                        "rename from src/old.ts",
                        "rename to src/new.ts",
                        "--- a/src/old.ts",
                        "+++ b/src/new.ts",
                        `+${"x".repeat(300_000)}`,
                        "",
                      ].join("\n"),
                      truncated: false,
                      nextCursor: "2",
                    }
                  : {
                      patch: [
                        "diff --git a/gone.md b/gone.md",
                        "deleted file mode 100644",
                        "--- a/gone.md",
                        "+++ /dev/null",
                        `-${"x".repeat(300_000)}`,
                        "",
                      ].join("\n"),
                      truncated: false,
                      nextCursor: null,
                    };
              }),
            getDiffFileContents: (input) =>
              Effect.sync(() => {
                read.push(`${input.oldPath}->${input.newPath}`);
                return { oldContents: "old", newContents: "new" };
              }),
          }),
        ],
      });
      const ref = { projectId: "p1" as ProjectId, repository: "pingdotgg/t3code", number: 1 };

      yield* service.diff(ref);
      yield* service.diff({ ...ref, cursor: "2" });

      yield* service.diffFileContents({
        ...ref,
        changeType: "rename-changed",
        oldPath: "src/old.ts",
        newPath: "src/new.ts",
      });
      yield* service.diffFileContents({
        ...ref,
        changeType: "deleted",
        oldPath: "gone.md",
        newPath: "gone.md",
      });
      const outside = yield* service
        .diffFileContents({ ...ref, changeType: "deleted", oldPath: ".env", newPath: ".env" })
        .pipe(Effect.flip);
      const halfRename = yield* service
        .diffFileContents({
          ...ref,
          changeType: "change",
          oldPath: "src/secret.ts",
          newPath: "src/new.ts",
        })
        .pipe(Effect.flip);

      assert.strictEqual(outside._tag, "PullRequestOperationError");
      assert.strictEqual(halfRename._tag, "PullRequestOperationError");
      assert.deepStrictEqual(read, ["src/old.ts->src/new.ts", "gone.md->gone.md"]);
      assert.deepStrictEqual(diffReads, [undefined, "2"]);
    }),
);

// Refresh and expiry are covered by the in-flight test below; repository and number share the ref key.
it.effect.each(["commit", "credential"] as const)(
  "does not reuse loaded diff membership after changing %s",
  (boundary) =>
    Effect.gen(function* () {
      let credential = "broad";
      let diffReads = 0;
      let contentReads = 0;
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            withVerifiedCredential: (_, use) =>
              Effect.suspend(() =>
                use({ accountId: "101", viewer: "octocat", credentialFingerprint: credential }),
              ),
            getDiff: () =>
              Effect.sync(() => ({
                patch:
                  ++diffReads === 1
                    ? `diff --git a/private.ts b/private.ts\n--- a/private.ts\n+++ b/private.ts\n+${"x".repeat(300_000)}\n`
                    : "",
                truncated: false,
                nextCursor: null,
              })),
            getDiffFileContents: () =>
              Effect.sync(() => {
                contentReads += 1;
                return { oldContents: "old", newContents: "new" };
              }),
          }),
        ],
      });
      const ref = {
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        host: "github.com",
        expectedAccountId: "101",
      };
      // Load at a commit and expand without one so the commit must be part of the membership key.
      const loaded = boundary === "commit" ? { ...ref, commit: "a".repeat(40) } : ref;
      yield* service.withRoutingCredential(loaded, service.diff(loaded));
      if (boundary === "credential") credential = "restricted";
      const input = {
        ...ref,
        changeType: "change" as const,
        oldPath: "private.ts",
        newPath: "private.ts",
      };
      const error = yield* service
        .withRoutingCredential(input, service.diffFileContents(input))
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "PullRequestOperationError");
      assert.strictEqual(error.reason, "not-found");
      assert.strictEqual(diffReads, 2);
      assert.strictEqual(contentReads, 0);
    }),
);
it.effect.each(["expiry", "commit expiry", "cache hit", "commit cache hit", "refresh"] as const)(
  "keeps a loaded diff's original membership scope through an in-flight %s",
  (boundary) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let diffReads = 0;
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            getDiff: () =>
              Effect.gen(function* () {
                if (++diffReads !== 1) return { patch: "", truncated: false, nextCursor: null };
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return {
                  patch: `diff --git a/private.ts b/private.ts\n--- a/private.ts\n+++ b/private.ts\n+${"x".repeat(300_000)}\n`,
                  truncated: false,
                  nextCursor: null,
                };
              }),
            getDiffFileContents: () => Effect.succeed({ oldContents: "old", newContents: "new" }),
          }),
        ],
      });
      const ref = {
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        ...(boundary.includes("commit") ? { commit: "a".repeat(40) } : {}),
      };
      const loading = yield* Effect.forkChild(service.diff(ref));
      yield* Deferred.await(started);
      if (boundary === "expiry") yield* TestClock.adjust("61 seconds");
      else if (boundary === "commit expiry") yield* TestClock.adjust("11 minutes");
      else if (boundary.includes("cache hit")) yield* TestClock.adjust("30 seconds");
      else yield* service.invalidate({ reference: ref });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(loading);
      if (boundary.includes("cache hit")) {
        yield* service.diff(ref);
        yield* service.diff(ref);
        yield* TestClock.adjust(boundary.includes("commit") ? "9 minutes" : "29 seconds");
        assert.deepStrictEqual(
          yield* service.diffFileContents({
            ...ref,
            changeType: "change",
            oldPath: "private.ts",
            newPath: "private.ts",
          }),
          { oldContents: "old", newContents: "new" },
        );
        assert.strictEqual(diffReads, 1);
        yield* TestClock.adjust(boundary.includes("commit") ? "1 minute" : "2 seconds");
      }
      const error = yield* service
        .diffFileContents({
          ...ref,
          changeType: "change",
          oldPath: "private.ts",
          newPath: "private.ts",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "PullRequestOperationError");
      assert.strictEqual(error.reason, "not-found");
      assert.strictEqual(diffReads, 2);
    }),
);
