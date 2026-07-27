import * as AWS from "@/AWS";
import { PublicRepository } from "@/AWS/ECRPublic";
import * as Test from "@/Test/Alchemy";
import * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import { Region } from "@distilled.cloud/aws/Region";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// ECR Public is a global registry hosted only in us-east-1; every out-of-band
// verification call must target that region regardless of the stack region.
const pin = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Region, Effect.succeed("us-east-1")));

const findRepository = (repositoryName: string) =>
  pin(
    ecrpublic.describeRepositories({ repositoryNames: [repositoryName] }),
  ).pipe(
    Effect.map((r) => r.repositories?.[0]),
    Effect.catchTag("RepositoryNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

class RepositoryStillExists extends Data.TaggedError("RepositoryStillExists")<{
  readonly repositoryName: string;
}> {}

const assertRepositoryDeleted = (repositoryName: string) =>
  findRepository(repositoryName).pipe(
    Effect.flatMap((repo) =>
      repo === undefined
        ? Effect.void
        : Effect.fail(new RepositoryStillExists({ repositoryName })),
    ),
    Effect.retry({
      while: (e) => e._tag === "RepositoryStillExists",
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(15),
      ]),
    }),
  );

test.provider(
  "create, update catalog data, delete public repository",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* PublicRepository("TestPublicRepo", {
            catalogData: {
              description: "initial description",
              architectures: ["x86-64"],
              operatingSystems: ["Linux"],
            },
            tags: { Environment: "test" },
          });
        }),
      );

      expect(repo.repositoryName).toBeDefined();
      expect(repo.repositoryArn).toContain(":repository/");
      expect(repo.repositoryUri).toContain("public.ecr.aws");

      const created = yield* findRepository(repo.repositoryName);
      expect(created?.repositoryArn).toBe(repo.repositoryArn);

      const catalog = yield* pin(
        ecrpublic.getRepositoryCatalogData({
          repositoryName: repo.repositoryName,
        }),
      );
      expect(catalog.catalogData?.description).toBe("initial description");

      const tags = yield* pin(
        ecrpublic.listTagsForResource({ resourceArn: repo.repositoryArn }),
      ).pipe(
        Effect.map((r) =>
          Object.fromEntries((r.tags ?? []).map((t) => [t.Key, t.Value])),
        ),
      );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("TestPublicRepo");

      // Update catalog data + tags.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* PublicRepository("TestPublicRepo", {
            catalogData: {
              description: "updated description",
              architectures: ["x86-64", "ARM 64"],
              operatingSystems: ["Linux"],
            },
            tags: { Environment: "test", Extra: "yes" },
          });
        }),
      );
      expect(updated.repositoryArn).toBe(repo.repositoryArn);

      const catalog2 = yield* pin(
        ecrpublic.getRepositoryCatalogData({
          repositoryName: repo.repositoryName,
        }),
      );
      expect(catalog2.catalogData?.description).toBe("updated description");

      const tags2 = yield* pin(
        ecrpublic.listTagsForResource({ resourceArn: repo.repositoryArn }),
      ).pipe(
        Effect.map((r) =>
          Object.fromEntries((r.tags ?? []).map((t) => [t.Key, t.Value])),
        ),
      );
      expect(tags2.Extra).toBe("yes");

      yield* stack.destroy();
      yield* assertRepositoryDeleted(repo.repositoryName);
    }),
  { timeout: 180_000 },
);
