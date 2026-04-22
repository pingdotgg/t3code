import { realpathSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Duration, Effect, FileSystem, Layer } from "effect";
import { TestClock } from "effect/testing";

import { runProcess } from "../../processRunner.ts";
import { RepositoryIdentityResolver } from "../Services/RepositoryIdentityResolver.ts";
import {
  makeRepositoryIdentityResolver,
  RepositoryIdentityResolverLive,
} from "./RepositoryIdentityResolver.ts";

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) =>
  normalizePathSeparators(realpathSync.native(value));

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.promise(() => runProcess("git", ["-C", cwd, ...args]));

const makeRepositoryIdentityResolverTestLayer = (options: {
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}) =>
  Layer.effect(
    RepositoryIdentityResolver,
    makeRepositoryIdentityResolver({
      cacheCapacity: 16,
      ...options,
    }),
  );

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("normalizes equivalent GitHub remotes into a stable repository identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "harness-repository-identity-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:Harness/harness.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/harness");
      expect(normalizeResolvedPath(identity?.rootPath ?? "")).toBe(normalizeResolvedPath(cwd));
      expect(identity?.displayName).toBe("t3tools/harness");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("t3tools");
      expect(identity?.name).toBe("harness");
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("returns the git top-level root path when resolving from a nested workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "harness-repository-identity-nested-root-test-",
      });
      const nestedWorkspace = `${repoRoot}/packages/web`;

      yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:Harness/harness.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(nestedWorkspace);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/harness");
      expect(normalizeResolvedPath(identity?.rootPath ?? "")).toBe(normalizeResolvedPath(repoRoot));
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("returns null for non-git folders and repos without remotes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nonGitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "harness-repository-identity-non-git-",
      });
      const gitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "harness-repository-identity-no-remote-",
      });

      yield* git(gitDir, ["init"]);

      const resolver = yield* RepositoryIdentityResolver;
      const nonGitIdentity = yield* resolver.resolve(nonGitDir);
      const noRemoteIdentity = yield* resolver.resolve(gitDir);

      expect(nonGitIdentity).toBeNull();
      expect(noRemoteIdentity).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("prefers upstream over origin when both remotes are configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "harness-repository-identity-upstream-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/harness.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:Harness/harness.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.locator.remoteName).toBe("upstream");
      expect(identity?.canonicalKey).toBe("github.com/t3tools/harness");
      expect(identity?.displayName).toBe("t3tools/harness");
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("uses the last remote path segment as the repository name for nested groups", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "harness-repository-identity-nested-group-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@gitlab.com:Harness/platform/harness.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("gitlab.com/t3tools/platform/harness");
      expect(identity?.displayName).toBe("t3tools/platform/harness");
      expect(identity?.owner).toBe("t3tools");
      expect(identity?.name).toBe("harness");
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect(
    "keeps null identities cached across repeated resolves until the negative TTL expires",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "harness-repository-identity-late-remote-test-",
        });

        yield* git(cwd, ["init"]);

        const resolver = yield* RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity).toBeNull();

        yield* git(cwd, ["remote", "add", "origin", "git@github.com:Harness/harness.git"]);

        for (const _attempt of [1, 2, 3]) {
          const cachedIdentity = yield* resolver.resolve(cwd);
          expect(cachedIdentity).toBeNull();
        }

        yield* TestClock.adjust(Duration.millis(120));

        const refreshedIdentity = yield* resolver.resolve(cwd);
        expect(refreshedIdentity).not.toBeNull();
        expect(refreshedIdentity?.canonicalKey).toBe("github.com/t3tools/harness");
        expect(refreshedIdentity?.name).toBe("harness");
      }).pipe(
        Effect.provide(
          Layer.merge(
            TestClock.layer(),
            makeRepositoryIdentityResolverTestLayer({
              negativeCacheTtl: Duration.millis(50),
              positiveCacheTtl: Duration.seconds(1),
            }),
          ),
        ),
      ),
  );

  it.effect("refreshes cached identities after the positive TTL when a remote changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "harness-repository-identity-remote-change-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:Harness/harness.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const initialIdentity = yield* resolver.resolve(cwd);
      expect(initialIdentity).not.toBeNull();
      expect(initialIdentity?.canonicalKey).toBe("github.com/t3tools/harness");

      yield* git(cwd, ["remote", "set-url", "origin", "git@github.com:Harness/harness-next.git"]);

      const cachedIdentity = yield* resolver.resolve(cwd);
      expect(cachedIdentity).not.toBeNull();
      expect(cachedIdentity?.canonicalKey).toBe("github.com/t3tools/harness");

      yield* TestClock.adjust(Duration.millis(180));

      const refreshedIdentity = yield* resolver.resolve(cwd);
      expect(refreshedIdentity).not.toBeNull();
      expect(refreshedIdentity?.canonicalKey).toBe("github.com/t3tools/harness-next");
      expect(refreshedIdentity?.displayName).toBe("t3tools/harness-next");
      expect(refreshedIdentity?.name).toBe("harness-next");
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          makeRepositoryIdentityResolverTestLayer({
            negativeCacheTtl: Duration.millis(50),
            positiveCacheTtl: Duration.millis(100),
          }),
        ),
      ),
    ),
  );
});
