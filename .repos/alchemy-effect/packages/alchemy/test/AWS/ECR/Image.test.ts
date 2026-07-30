import * as AWS from "@/AWS";
import { Image } from "@/AWS/ECR/Image.ts";
import { Repository } from "@/AWS/ECR/Repository.ts";
import * as Test from "@/Test/Alchemy";
import * as ecr from "@distilled.cloud/aws/ecr";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Checked-in build fixture: `FROM scratch` + one COPY'd file, so the build is
// fully deterministic and never fetches a base image over the network.
const fixtureDir = `${import.meta.dirname}/fixtures/image`;

test.provider(
  "build, push, skip on no-op, rebuild on content change, destroy",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* stack.destroy();

      // Copy the fixture into a mutable temp context so the content-change
      // step never dirties the checked-in fixture. The content hash covers
      // relative paths + bytes only, so the temp location doesn't affect it.
      const context = yield* fs.makeTempDirectory({
        prefix: "alchemy-ecr-image-",
      });
      yield* fs.copy(fixtureDir, context, { overwrite: true });

      const deployImage = () =>
        stack.deploy(
          Effect.gen(function* () {
            const repository = yield* Repository("ImageRepository", {
              repositoryName: "alchemy-test-ecr-image",
            });
            return yield* Image("Image", {
              repositoryUri: repository.repositoryUri,
              context,
            });
          }),
        );

      const first = yield* deployImage();
      expect(first.repositoryName).toBe("alchemy-test-ecr-image");
      expect(first.ownsRepository).toBe(false);
      expect(first.digest).toMatch(/^sha256:/);
      expect(first.imageUri).toBe(`${first.repositoryUri}:${first.imageTag}`);

      // Out-of-band: the manifest exists in ECR with the reported digest.
      const described = yield* ecr.describeImages({
        repositoryName: first.repositoryName,
        imageIds: [{ imageTag: first.imageTag }],
      });
      expect(described.imageDetails?.[0]?.imageDigest).toBe(first.digest);

      // Unchanged content: redeploy is a no-op — same tag, same digest.
      const second = yield* deployImage();
      expect(second.imageTag).toBe(first.imageTag);
      expect(second.digest).toBe(first.digest);

      // Content change: new hash tag + new digest on the same resource.
      yield* fs.writeFileString(
        path.join(context, "hello.txt"),
        "hello again from alchemy\n",
      );
      const third = yield* deployImage();
      expect(third.imageTag).not.toBe(first.imageTag);
      expect(third.digest).not.toBe(first.digest);
      const redescribed = yield* ecr.describeImages({
        repositoryName: third.repositoryName,
        imageIds: [{ imageTag: third.imageTag }],
      });
      expect(redescribed.imageDetails?.[0]?.imageDigest).toBe(third.digest);

      yield* stack.destroy();

      // The Repository owns the repo and force-deletes it (taking every
      // image tag with it).
      yield* assertRepositoryDeleted(first.repositoryName);
    }),
  { timeout: 240_000 },
);

test.provider(
  "auto-creates and owns a repository when none is given",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const image = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Image("OwnedImage", {
            context: fixtureDir,
          });
        }),
      );

      expect(image.ownsRepository).toBe(true);
      expect(image.digest).toMatch(/^sha256:/);

      // Out-of-band: the auto-created repository holds the pushed manifest.
      const described = yield* ecr.describeImages({
        repositoryName: image.repositoryName,
        imageIds: [{ imageTag: image.imageTag }],
      });
      expect(described.imageDetails?.[0]?.imageDigest).toBe(image.digest);

      yield* stack.destroy();

      // Destroying an owning Image force-deletes its repository.
      yield* assertRepositoryDeleted(image.repositoryName);
    }),
  { timeout: 240_000 },
);

class RepositoryStillExists extends Data.TaggedError("RepositoryStillExists") {}

const assertRepositoryDeleted = Effect.fn(function* (repositoryName: string) {
  yield* ecr.describeRepositories({ repositoryNames: [repositoryName] }).pipe(
    Effect.flatMap(() => Effect.fail(new RepositoryStillExists())),
    Effect.retry({
      while: (e) => e._tag === "RepositoryStillExists",
      schedule: Schedule.max([Schedule.exponential(250), Schedule.recurs(8)]),
    }),
    Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
  );
});
