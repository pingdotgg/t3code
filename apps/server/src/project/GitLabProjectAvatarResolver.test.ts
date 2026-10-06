import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

import type { RepositoryIdentity } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as GitLabProjectAvatarResolver from "./GitLabProjectAvatarResolver.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);
const BMP = new Uint8Array([0x42, 0x4d, 7, 8, 9]);

const gitLabIdentity: RepositoryIdentity = {
  canonicalKey: "gitlab.com/group/project",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@gitlab.com:group/project.git",
  },
  provider: "gitlab",
};

const gitHubIdentity: RepositoryIdentity = {
  ...gitLabIdentity,
  canonicalKey: "github.com/group/project",
  provider: "github",
};

const glabSignedOut = new GitLabCli.GitLabCliAuthenticationError({
  operation: "execute",
  command: "glab",
  cwd: "/repo",
  cause: new Error("401 Unauthorized"),
});

type AvatarAnswer = Uint8Array | null | GitLabCli.GitLabCliError;

// Each download takes the next answer: bytes, null for GitLab's 404, or a failure.
const makeResolver = (input: {
  readonly identity: RepositoryIdentity | null;
  readonly answers: Array<AvatarAnswer>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-gitlab-project-avatar-",
    });
    // Start the test clock at the real time, so cache file mtimes and the clock agree.
    const created = yield* fileSystem.stat(baseDir);
    yield* TestClock.setTime(Option.getOrThrow(created.mtime).getTime());
    const downloads = { count: 0 };
    const resolver = yield* GitLabProjectAvatarResolver.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(GitLabCli.GitLabCli)({
            getProjectAvatar: () =>
              Effect.suspend(() => {
                downloads.count += 1;
                const answer = input.answers.shift();
                if (answer === undefined) return Effect.die("unexpected avatar download");
                return answer === null || answer instanceof Uint8Array
                  ? Effect.succeed(answer)
                  : Effect.fail(answer);
              }),
          }),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () => Effect.succeed(input.identity),
          }),
          ServerConfig.ServerConfig.layerTest(process.cwd(), baseDir),
        ),
      ),
    );
    return { resolver, downloads };
  });

const withClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(TestClock.layer()));

const layerTest = NodeServices.layer;

it.layer(layerTest)("GitLabProjectAvatarResolver", (it) => {
  describe("resolvePath", () => {
    it.effect("downloads a GitLab project's avatar once and serves it from disk", () =>
      withClock(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const { resolver, downloads } = yield* makeResolver({
            identity: gitLabIdentity,
            answers: [PNG],
          });

          const resolved = yield* resolver.resolvePath("/repo");

          expect(resolved?.endsWith(".png")).toBe(true);
          expect(new Uint8Array(yield* fileSystem.readFile(resolved!))).toEqual(PNG);
          expect(resolver.isManagedPath(resolved!)).toBe(true);
          expect(yield* resolver.resolvePath("/repo")).toBe(resolved);
          expect(downloads.count).toBe(1);
        }),
      ),
    );

    it.effect("never asks glab about repositories hosted elsewhere", () =>
      withClock(
        Effect.gen(function* () {
          const { resolver, downloads } = yield* makeResolver({
            identity: gitHubIdentity,
            answers: [],
          });

          expect(yield* resolver.resolvePath("/repo")).toBeNull();
          expect(downloads.count).toBe(0);
        }),
      ),
    );

    it.effect("remembers a project without an avatar until the cache expires", () =>
      withClock(
        Effect.gen(function* () {
          const { resolver, downloads } = yield* makeResolver({
            identity: gitLabIdentity,
            answers: [null, PNG],
          });

          expect(yield* resolver.resolvePath("/repo")).toBeNull();
          expect(yield* resolver.resolvePath("/repo")).toBeNull();
          expect(downloads.count).toBe(1);

          yield* TestClock.adjust(Duration.days(2));

          expect((yield* resolver.resolvePath("/repo"))?.endsWith(".png")).toBe(true);
          expect(downloads.count).toBe(2);
        }),
      ),
    );

    it.effect("treats an image browsers cannot render as no avatar", () =>
      withClock(
        Effect.gen(function* () {
          const { resolver } = yield* makeResolver({
            identity: gitLabIdentity,
            answers: [BMP],
          });

          expect(yield* resolver.resolvePath("/repo")).toBeNull();
        }),
      ),
    );

    it.effect("waits before asking glab again after it fails", () =>
      withClock(
        Effect.gen(function* () {
          const { resolver, downloads } = yield* makeResolver({
            identity: gitLabIdentity,
            answers: [glabSignedOut, PNG],
          });

          expect(yield* resolver.resolvePath("/repo")).toBeNull();
          expect(yield* resolver.resolvePath("/repo")).toBeNull();
          expect(downloads.count).toBe(1);

          yield* TestClock.adjust(Duration.minutes(11));

          expect((yield* resolver.resolvePath("/repo"))?.endsWith(".png")).toBe(true);
          expect(downloads.count).toBe(2);
        }),
      ),
    );

    it.effect("keeps serving an expired avatar while glab cannot refresh it", () =>
      withClock(
        Effect.gen(function* () {
          const { resolver } = yield* makeResolver({
            identity: gitLabIdentity,
            answers: [PNG, glabSignedOut],
          });

          const resolved = yield* resolver.resolvePath("/repo");
          yield* TestClock.adjust(Duration.days(2));

          expect(yield* resolver.resolvePath("/repo")).toBe(resolved);
        }),
      ),
    );

    it.effect("replaces an expired avatar with the project's new one", () =>
      withClock(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const { resolver } = yield* makeResolver({
            identity: gitLabIdentity,
            answers: [PNG, JPEG, null],
          });

          const first = yield* resolver.resolvePath("/repo");
          yield* TestClock.adjust(Duration.days(2));
          const second = yield* resolver.resolvePath("/repo");

          expect(second?.endsWith(".jpg")).toBe(true);
          expect(yield* fileSystem.exists(first!)).toBe(false);

          // The project's avatar was removed on GitLab.
          yield* TestClock.adjust(Duration.days(2));
          expect(yield* resolver.resolvePath("/repo")).toBeNull();
          expect(yield* fileSystem.exists(second!)).toBe(false);
        }),
      ),
    );
  });

  describe("isManagedPath", () => {
    it.effect("accepts only files inside the avatar cache", () =>
      withClock(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const { resolver } = yield* makeResolver({
            identity: gitLabIdentity,
            answers: [PNG],
          });
          const resolved = (yield* resolver.resolvePath("/repo"))!;
          const cacheDir = path.dirname(resolved);

          expect(resolver.isManagedPath(resolved)).toBe(true);
          expect(resolver.isManagedPath(cacheDir)).toBe(false);
          expect(resolver.isManagedPath(path.join(cacheDir, "..", "statev2.sqlite"))).toBe(false);
          expect(resolver.isManagedPath("/repo/favicon.png")).toBe(false);
        }),
      ),
    );
  });
});
