import { Bucket, BucketProvider, type BucketProps } from "@/Prisma/Bucket";
import {
  BucketAccessKey,
  BucketAccessKeyProvider,
  type BucketAccessKeyProps,
} from "@/Prisma/BucketAccessKey";
import {
  PrismaApiError,
  PrismaClient,
  type PrismaManagementClient,
} from "@/Prisma/Client";
import type {
  Bucket as ApiBucket,
  BucketKey as ApiBucketKey,
  BucketKeyWithSecret,
} from "@/Prisma/Types";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "@/AlchemyContext";

const createdAt = "2026-01-01T00:00:00.000Z";
const instanceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
// physicalBucketAccessKeyName(logical id "BucketAccessKey", instanceId above)
const expectedKeyName = "BucketAccessKey-aaaaaaaaaaaa";

const apiBucket = (id: string, name: string): ApiBucket => ({
  id,
  type: "bucket",
  url: `https://api.prisma.test/v1/buckets/${id}`,
  name,
  providerName: "aws",
  status: "ready",
  createdAt,
  project: {
    id: "project-1",
    url: "https://api.prisma.test/v1/projects/project-1",
    name: "app",
  },
  branchId: null,
});

const bucketAttrs = (id: string, name: string): Bucket["Attributes"] => ({
  bucketId: id,
  name,
  projectId: "project-1",
  createdAt,
});

const apiBucketKey = (id: string, name = expectedKeyName): ApiBucketKey => ({
  id,
  type: "bucketKey",
  name,
  valueHint: "AKIA...",
  role: "read_write",
  createdAt,
});

const apiBucketKeyWithSecret = (id: string): BucketKeyWithSecret => ({
  ...apiBucketKey(id),
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "one-time-secret",
  endpoint: "https://s3.prisma.test",
  bucketName: "user-bucket-1",
});

const persistedKeyAttrs = (id: string): BucketAccessKey["Attributes"] => ({
  bucketAccessKeyId: id,
  bucketId: "bucket-1",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: Redacted.make("one-time-secret"),
  endpoint: "https://s3.prisma.test",
  bucketName: "user-bucket-1",
});

const notFound = (path: string) =>
  new PrismaApiError({
    method: "GET",
    path,
    status: 404,
    message: "HTTP 404",
  });

const liveProviderContext = Layer.succeed(AlchemyContext, {
  dotAlchemy: ".alchemy-test",
  dev: false,
  adopt: false,
});

const bucketLayer = (client: PrismaManagementClient) =>
  BucketProvider().pipe(
    Layer.provide(Layer.succeed(PrismaClient, client)),
    Layer.provide(liveProviderContext),
  );

const bucketKeyLayer = (client: PrismaManagementClient) =>
  BucketAccessKeyProvider().pipe(
    Layer.provide(Layer.succeed(PrismaClient, client)),
    Layer.provide(liveProviderContext),
  );

const reconcileInput = <Props, Attributes>(
  id: string,
  news: Props,
  output?: Attributes,
  olds?: Props,
) => ({
  id,
  fqn: id,
  instanceId,
  news,
  olds,
  output,
  session: undefined as never,
  bindings: [],
});

const diffInput = <Props, Attributes>(
  id: string,
  olds: Props,
  news: Props,
  output?: Attributes,
) =>
  ({
    id,
    fqn: id,
    instanceId,
    olds,
    news,
    output,
  }) as never;

describe("Prisma Bucket provider", () => {
  it.effect("creates a bucket when none is persisted", () => {
    let creates = 0;
    const client = {
      createBucket: (input: {
        projectId: string;
        name?: string;
        branchId?: string;
      }) =>
        Effect.sync(() => {
          creates += 1;
          expect(input.projectId).toBe("project-1");
          expect(input.name).toBe("uploads");
          expect(input.branchId).toBeUndefined();
          return apiBucket("bucket-1", "uploads");
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Bucket.Provider;
      const attrs = yield* provider.reconcile(
        reconcileInput("Bucket", { project: "project-1", name: "uploads" }),
      );

      expect(creates).toBe(1);
      expect(attrs).toEqual(bucketAttrs("bucket-1", "uploads"));
    }).pipe(Effect.provide(bucketLayer(client)));
  });

  it.effect("returns the observed bucket without creating again", () => {
    let creates = 0;
    const client = {
      getBucket: (id: string) => Effect.succeed(apiBucket(id, "uploads")),
      createBucket: () =>
        Effect.sync(() => {
          creates += 1;
          return apiBucket("bucket-2", "uploads");
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Bucket.Provider;
      const attrs = yield* provider.reconcile(
        reconcileInput(
          "Bucket",
          { project: "project-1", name: "uploads" },
          bucketAttrs("bucket-1", "uploads"),
        ),
      );

      expect(creates).toBe(0);
      expect(attrs.bucketId).toBe("bucket-1");
    }).pipe(Effect.provide(bucketLayer(client)));
  });

  it.effect("refuses convergence when the bucket moved projects", () => {
    const client = {
      getBucket: (id: string) =>
        Effect.succeed({
          ...apiBucket(id, "uploads"),
          project: {
            id: "project-other",
            url: "https://api.prisma.test/v1/projects/project-other",
            name: "other",
          },
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Bucket.Provider;
      const result = yield* provider
        .reconcile(
          reconcileInput(
            "Bucket",
            { project: "project-1", name: "uploads" },
            bucketAttrs("bucket-1", "uploads"),
          ),
        )
        .pipe(Effect.flip);

      expect(String(result)).toContain("Refusing to claim convergence");
    }).pipe(Effect.provide(bucketLayer(client)));
  });

  it.effect("recreates the bucket when the persisted one is gone", () => {
    let creates = 0;
    const client = {
      getBucket: (id: string) => Effect.fail(notFound(`/v1/buckets/${id}`)),
      createBucket: () =>
        Effect.sync(() => {
          creates += 1;
          return apiBucket("bucket-2", "uploads");
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Bucket.Provider;
      const attrs = yield* provider.reconcile(
        reconcileInput(
          "Bucket",
          { project: "project-1", name: "uploads" },
          bucketAttrs("bucket-1", "uploads"),
        ),
      );

      expect(creates).toBe(1);
      expect(attrs.bucketId).toBe("bucket-2");
    }).pipe(Effect.provide(bucketLayer(client)));
  });

  it.effect("read refreshes from the API and reports a gone bucket", () => {
    const client = {
      getBucket: (id: string) =>
        id === "bucket-1"
          ? Effect.succeed(apiBucket(id, "uploads"))
          : Effect.fail(notFound(`/v1/buckets/${id}`)),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Bucket.Provider;
      const observed = yield* provider.read!({
        id: "Bucket",
        fqn: "Bucket",
        instanceId,
        olds: { project: "project-1", name: "uploads" },
        output: bucketAttrs("bucket-1", "uploads"),
      });
      expect(observed).toEqual(bucketAttrs("bucket-1", "uploads"));

      const gone = yield* provider.read!({
        id: "Bucket",
        fqn: "Bucket",
        instanceId,
        olds: { project: "project-1", name: "uploads" },
        output: bucketAttrs("bucket-2", "uploads"),
      });
      expect(gone).toBeUndefined();
    }).pipe(Effect.provide(bucketLayer(client)));
  });

  it.effect("replaces on project, name, or branch changes", () => {
    const client = {} as unknown as PrismaManagementClient;
    const olds: BucketProps = { project: "project-1", name: "uploads" };
    const output = bucketAttrs("bucket-1", "uploads");

    return Effect.gen(function* () {
      const provider = yield* Bucket.Provider;

      expect(
        yield* provider.diff!(
          diffInput(
            "Bucket",
            olds,
            { project: "project-2", name: "uploads" },
            output,
          ),
        ),
      ).toEqual({ action: "replace" });
      expect(
        yield* provider.diff!(
          diffInput(
            "Bucket",
            olds,
            { project: "project-1", name: "renamed" },
            output,
          ),
        ),
      ).toEqual({ action: "replace" });
      expect(
        yield* provider.diff!(
          diffInput(
            "Bucket",
            olds,
            { project: "project-1", name: "uploads", branchId: "branch-1" },
            output,
          ),
        ),
      ).toEqual({ action: "replace" });
      expect(
        yield* provider.diff!(diffInput("Bucket", olds, olds, output)),
      ).toBeUndefined();
    }).pipe(Effect.provide(bucketLayer(client)));
  });

  it.effect("delete verifies identity and tolerates a gone bucket", () => {
    let deletes = 0;
    const client = {
      getBucket: (id: string) =>
        id === "bucket-1"
          ? Effect.succeed(apiBucket(id, "uploads"))
          : Effect.fail(notFound(`/v1/buckets/${id}`)),
      deleteBucket: (id: string) =>
        Effect.sync(() => {
          deletes += 1;
        }).pipe(Effect.andThen(Effect.fail(notFound(`/v1/buckets/${id}`)))),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Bucket.Provider;
      yield* provider.delete({
        id: "Bucket",
        fqn: "Bucket",
        instanceId,
        olds: { project: "project-1", name: "uploads" },
        output: bucketAttrs("bucket-1", "uploads"),
        session: undefined as never,
      } as never);
      expect(deletes).toBe(1);

      // Already gone: delete is a no-op.
      yield* provider.delete({
        id: "Bucket",
        fqn: "Bucket",
        instanceId,
        olds: { project: "project-1", name: "uploads" },
        output: bucketAttrs("bucket-2", "uploads"),
        session: undefined as never,
      } as never);
      expect(deletes).toBe(1);

      // Drifted to another project: refuse to delete.
      const drifted = yield* provider
        .delete({
          id: "Bucket",
          fqn: "Bucket",
          instanceId,
          olds: { project: "project-1", name: "uploads" },
          output: { ...bucketAttrs("bucket-1", "uploads"), projectId: "p2" },
          session: undefined as never,
        } as never)
        .pipe(Effect.flip);
      expect(String(drifted)).toContain("Refusing to delete");
    }).pipe(Effect.provide(bucketLayer(client)));
  });
});

describe("Prisma BucketAccessKey provider", () => {
  it.effect(
    "creates a key under its deterministic name and redacts the secret",
    () => {
      let creates = 0;
      const client = {
        listBucketKeys: () => Effect.succeed([]),
        createBucketKey: (
          bucketId: string,
          input: { name?: string; role: string },
        ) =>
          Effect.sync(() => {
            creates += 1;
            expect(bucketId).toBe("bucket-1");
            expect(input.name).toBe(expectedKeyName);
            expect(input.role).toBe("read_write");
            return apiBucketKeyWithSecret("key-1");
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* BucketAccessKey.Provider;
        const attrs = yield* provider.reconcile(
          reconcileInput("BucketAccessKey", {
            bucket: "bucket-1",
            role: "read_write" as const,
          }),
        );

        expect(creates).toBe(1);
        expect(attrs.bucketAccessKeyId).toBe("key-1");
        expect(attrs.bucketId).toBe("bucket-1");
        expect(attrs.accessKeyId).toBe("AKIAEXAMPLE");
        expect(Redacted.value(attrs.secretAccessKey)).toBe("one-time-secret");
        expect(attrs.endpoint).toBe("https://s3.prisma.test");
        // The provider-side S3 bucket name, not the friendly display name.
        expect(attrs.bucketName).toBe("user-bucket-1");
      }).pipe(Effect.provide(bucketKeyLayer(client)));
    },
  );

  it.effect(
    "revokes an orphaned key from a lost create response before recreating",
    () => {
      // Simulates a crash after POST /keys but before state persist: the
      // retry sees no output, finds the deterministic name already taken,
      // revokes it (its secret is unrecoverable), and mints a fresh key.
      let deletes = 0;
      let creates = 0;
      const client = {
        listBucketKeys: () => Effect.succeed([apiBucketKey("key-orphan")]),
        deleteBucketKey: (bucketId: string, keyId: string) =>
          Effect.sync(() => {
            deletes += 1;
            expect(bucketId).toBe("bucket-1");
            expect(keyId).toBe("key-orphan");
          }),
        createBucketKey: () =>
          Effect.sync(() => {
            creates += 1;
            return apiBucketKeyWithSecret("key-2");
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* BucketAccessKey.Provider;
        const attrs = yield* provider.reconcile(
          reconcileInput("BucketAccessKey", {
            bucket: "bucket-1",
            role: "read_write" as const,
          }),
        );

        expect(deletes).toBe(1);
        expect(creates).toBe(1);
        expect(attrs.bucketAccessKeyId).toBe("key-2");
      }).pipe(Effect.provide(bucketKeyLayer(client)));
    },
  );

  it.effect(
    "fails with a tagged error when two keys share the recovery name",
    () => {
      // Two keys under the deterministic name leave nothing to recover:
      // picking either could revoke a key another deploy is using.
      const client = {
        listBucketKeys: () =>
          Effect.succeed([apiBucketKey("key-a"), apiBucketKey("key-b")]),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* BucketAccessKey.Provider;
        const error = yield* provider
          .reconcile(
            reconcileInput("BucketAccessKey", {
              bucket: "bucket-1",
              role: "read_write" as const,
            }),
          )
          .pipe(Effect.flip);

        expect(error._tag).toBe("AmbiguousBucketAccessKeyError");
        expect(error.message).toContain("refusing to select one arbitrarily");
      }).pipe(Effect.provide(bucketKeyLayer(client)));
    },
  );

  it.effect(
    "returns persisted attributes while the key exists, without re-creating",
    () => {
      let creates = 0;
      const client = {
        listBucketKeys: () => Effect.succeed([apiBucketKey("key-1")]),
        createBucketKey: () =>
          Effect.sync(() => {
            creates += 1;
            return apiBucketKeyWithSecret("key-2");
          }),
      } as unknown as PrismaManagementClient;

      const persisted = persistedKeyAttrs("key-1");

      return Effect.gen(function* () {
        const provider = yield* BucketAccessKey.Provider;
        const attrs = yield* provider.reconcile(
          reconcileInput(
            "BucketAccessKey",
            { bucket: "bucket-1", role: "read_write" as const },
            persisted,
            { bucket: "bucket-1", role: "read_write" as const },
          ),
        );

        // The secret is returned exactly once at creation; persisted state
        // stays authoritative while the key exists.
        expect(creates).toBe(0);
        expect(attrs).toBe(persisted);

        const observed = yield* provider.read!({
          id: "BucketAccessKey",
          fqn: "BucketAccessKey",
          instanceId,
          olds: { bucket: "bucket-1", role: "read_write" as const },
          output: persisted,
        });
        expect(observed).toBe(persisted);
      }).pipe(Effect.provide(bucketKeyLayer(client)));
    },
  );

  it.effect("mints fresh credentials when the key was revoked", () => {
    let creates = 0;
    const client = {
      listBucketKeys: () => Effect.succeed([]),
      createBucketKey: () =>
        Effect.sync(() => {
          creates += 1;
          return apiBucketKeyWithSecret("key-2");
        }),
    } as unknown as PrismaManagementClient;

    const persisted = persistedKeyAttrs("key-1");

    return Effect.gen(function* () {
      const provider = yield* BucketAccessKey.Provider;

      const observed = yield* provider.read!({
        id: "BucketAccessKey",
        fqn: "BucketAccessKey",
        instanceId,
        olds: { bucket: "bucket-1", role: "read_write" as const },
        output: persisted,
      });
      expect(observed).toBeUndefined();

      const attrs = yield* provider.reconcile(
        reconcileInput(
          "BucketAccessKey",
          { bucket: "bucket-1", role: "read_write" as const },
          persisted,
          { bucket: "bucket-1", role: "read_write" as const },
        ),
      );
      expect(creates).toBe(1);
      expect(attrs.bucketAccessKeyId).toBe("key-2");
    }).pipe(Effect.provide(bucketKeyLayer(client)));
  });

  it.effect("replaces on bucket, role, or name changes", () => {
    const client = {} as unknown as PrismaManagementClient;
    const olds: BucketAccessKeyProps = {
      bucket: "bucket-1",
      role: "read_write",
    };
    const output = persistedKeyAttrs("key-1");

    return Effect.gen(function* () {
      const provider = yield* BucketAccessKey.Provider;

      expect(
        yield* provider.diff!(
          diffInput(
            "BucketAccessKey",
            olds,
            { bucket: "bucket-2", role: "read_write" as const },
            output,
          ),
        ),
      ).toEqual({ action: "replace" });
      expect(
        yield* provider.diff!(
          diffInput(
            "BucketAccessKey",
            olds,
            { bucket: "bucket-1", role: "read" as const },
            output,
          ),
        ),
      ).toEqual({ action: "replace" });
      expect(
        yield* provider.diff!(
          diffInput(
            "BucketAccessKey",
            olds,
            { bucket: "bucket-1", role: "read_write" as const, name: "next" },
            output,
          ),
        ),
      ).toEqual({ action: "replace" });
      expect(
        yield* provider.diff!(diffInput("BucketAccessKey", olds, olds, output)),
      ).toBeUndefined();
    }).pipe(Effect.provide(bucketKeyLayer(client)));
  });

  it.effect("delete tolerates keys already revoked by bucket cascade", () => {
    let deletes = 0;
    const client = {
      deleteBucketKey: (bucketId: string, keyId: string) =>
        Effect.sync(() => {
          deletes += 1;
          expect(bucketId).toBe("bucket-1");
          expect(keyId).toBe("key-1");
        }).pipe(
          Effect.andThen(
            Effect.fail(notFound("/v1/buckets/bucket-1/keys/key-1")),
          ),
        ),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* BucketAccessKey.Provider;
      yield* provider.delete({
        id: "BucketAccessKey",
        fqn: "BucketAccessKey",
        instanceId,
        olds: { bucket: "bucket-1", role: "read_write" },
        output: persistedKeyAttrs("key-1"),
        session: undefined as never,
      } as never);

      expect(deletes).toBe(1);
    }).pipe(Effect.provide(bucketKeyLayer(client)));
  });
});
