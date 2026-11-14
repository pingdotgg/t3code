import * as Prisma from "@alchemy.run/prisma";
import { AmbiguousBucketAccessKeyError } from "@alchemy.run/prisma/BucketAccessKey";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  createBucketKey,
  deleteBucket,
  deleteBucketKey,
  getBucket,
  getBucketKeys,
  updateBucket,
} from "@distilled.cloud/prisma/management";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  expectGone,
  expectProjectGone,
  failureOf,
  forgetState,
  markCreating,
  patchStateAttr,
} from "./fixtures/Live.ts";

const live = Test.make({ providers: Prisma.providers() });

const liveTags = [
  "provider:prisma",
  "provider:prisma:bucket",
  "provider:prisma:branch",
  "provider:prisma:project",
  "live",
];

const keyTags = [...liveTags, "provider:prisma:bucketaccesskey"];

const observeBucket = (bucketId: string) =>
  getBucket({ bucketId }).pipe(Effect.map((response) => response.data));

const expectBucketGone = (bucketId: string) =>
  expectGone(
    getBucket({ bucketId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

const bucketStack = (props: { name?: string; logicalId?: string; onBranch?: boolean } = {}) =>
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", { createDatabase: false });
    const branch = yield* Prisma.Branch("Feature", { project, gitName: "feature/bucket" });
    const bucket = yield* Prisma.Bucket("Uploads", {
      project,
      ...(props.name === undefined ? {} : { name: props.name }),
      ...(props.logicalId === undefined ? {} : { logicalId: props.logicalId }),
      ...(props.onBranch ? { branchId: branch.branchId } : {}),
    });
    return { project, branch, bucket };
  });

const listKeys = (bucketId: string) =>
  getBucketKeys({ bucketId, limit: 100 }).pipe(Effect.map((page) => page.data));

const keyStack = (
  props: { role?: "read" | "read_write"; name?: string; bucket?: "first" | "second" } = {},
) =>
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", { createDatabase: false });
    const first = yield* Prisma.Bucket("First", { project });
    const second = yield* Prisma.Bucket("Second", { project });
    const key = yield* Prisma.BucketAccessKey("Key", {
      bucket: props.bucket === "second" ? second : first,
      role: props.role ?? "read_write",
      ...(props.name === undefined ? {} : { name: props.name }),
    });
    return { project, first, second, key };
  });

live.test.provider(
  "creates a bucket under its fqn logical ID and renames, moves, and rebinds it in place",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(bucketStack({ name: "uploads" }));
    expect(initial.bucket.logicalId).toBe("Uploads");
    const created = yield* observeBucket(initial.bucket.bucketId);
    expect(created.project.id).toBe(initial.project.projectId);
    expect(created.name).toBe("uploads");
    expect(created.logicalId).toBe("Uploads");

    const renamed = yield* stack.deploy(bucketStack({ name: "uploads-renamed" }));
    expect(renamed.bucket.bucketId).toBe(initial.bucket.bucketId);
    expect((yield* observeBucket(initial.bucket.bucketId)).name).toBe("uploads-renamed");

    // Move, rename, and rebind in one deploy. The API refuses logicalId with a
    // branch move, so the provider sets it in a second call.
    const together = yield* stack.deploy(
      bucketStack({ name: "uploads", onBranch: true, logicalId: "media" }),
    );
    expect(together.bucket.bucketId).toBe(initial.bucket.bucketId);
    const moved = yield* observeBucket(initial.bucket.bucketId);
    expect(moved.name).toBe("uploads");
    expect(moved.branchId).toBe(initial.branch.branchId);
    expect(moved.logicalId).toBe("media");

    // Removing the override returns to the fqn.
    const reverted = yield* stack.deploy(bucketStack({ name: "uploads", onBranch: true }));
    expect(reverted.bucket.bucketId).toBe(initial.bucket.bucketId);
    expect((yield* observeBucket(initial.bucket.bucketId)).logicalId).toBe("Uploads");

    // Omitting branchId leaves the bucket on the branch it has.
    const omitted = yield* stack.deploy(bucketStack({ name: "uploads" }));
    expect(omitted.bucket.bucketId).toBe(initial.bucket.bucketId);
    expect((yield* observeBucket(initial.bucket.bucketId)).branchId).toBe(initial.branch.branchId);

    const repeated = yield* stack.deploy(bucketStack({ name: "uploads" }));
    expect(repeated.bucket.bucketId).toBe(initial.bucket.bucketId);

    // Nuke enumerates buckets through the provider's list.
    const listed = yield* (yield* Provider.findProvider(Prisma.Bucket)).list!();
    expect(listed.map((bucket) => bucket.bucketId)).toContain(initial.bucket.bucketId);

    yield* stack.destroy();
    yield* expectBucketGone(initial.bucket.bucketId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "after lost state, adoption finds the bucket by its logical ID despite a Console rename",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(bucketStack({ name: "uploads" }));
    yield* updateBucket({ bucketId: initial.bucket.bucketId, displayName: "renamed-in-console" });
    yield* forgetState(stack, "Uploads");

    // A bucket has no generated name, so nothing proves it is ours.
    const refused = yield* failureOf(stack.deploy(bucketStack({ name: "uploads" })));
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);

    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const branch = yield* Prisma.Branch("Feature", { project, gitName: "feature/bucket" });
        const bucket = yield* Prisma.Bucket("Uploads", { project, name: "uploads" }).pipe(
          adopt(true),
        );
        return { project, branch, bucket };
      }),
    );
    expect(adopted.bucket.bucketId).toBe(initial.bucket.bucketId);
    const observed = yield* observeBucket(initial.bucket.bucketId);
    expect(observed.name).toBe("uploads");
    expect(observed.logicalId).toBe("Uploads");

    yield* stack.destroy();
    yield* expectBucketGone(initial.bucket.bucketId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "sets the logical ID on a bucket deployed before logical IDs existed",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(bucketStack({ name: "uploads" }));
    yield* updateBucket({ bucketId: initial.bucket.bucketId, logicalId: null });
    yield* patchStateAttr(stack, "Uploads", { logicalId: null });
    expect((yield* observeBucket(initial.bucket.bucketId)).logicalId).toBeNull();

    const stamped = yield* stack.deploy(bucketStack({ name: "uploads" }));
    expect(stamped.bucket.bucketId).toBe(initial.bucket.bucketId);
    expect(stamped.bucket.logicalId).toBe("Uploads");
    expect((yield* observeBucket(initial.bucket.bucketId)).logicalId).toBe("Uploads");

    yield* stack.destroy();
    yield* expectBucketGone(initial.bucket.bucketId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "replaces the bucket when its project changes",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    // Both projects exist before the move, so the new project ID is known at plan time.
    const resources = (target: "first" | "second") =>
      Effect.gen(function* () {
        const first = yield* Prisma.Project("First", { createDatabase: false });
        const second = yield* Prisma.Project("Second", { createDatabase: false });
        const bucket = yield* Prisma.Bucket("Uploads", {
          project: target === "first" ? first : second,
          name: "uploads",
        });
        return { first, second, bucket };
      });

    const initial = yield* stack.deploy(resources("first"));
    const replaced = yield* stack.deploy(resources("second"));
    expect(replaced.bucket.bucketId).not.toBe(initial.bucket.bucketId);
    expect(replaced.bucket.projectId).toBe(initial.second.projectId);
    const observed = yield* observeBucket(replaced.bucket.bucketId);
    expect(observed.project.id).toBe(initial.second.projectId);
    expect(observed.logicalId).toBe("Uploads");
    yield* expectBucketGone(initial.bucket.bucketId);

    yield* stack.destroy();
    yield* expectBucketGone(replaced.bucket.bucketId);
    yield* expectProjectGone(initial.first.projectId);
    yield* expectProjectGone(initial.second.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "rejects a logical ID that another bucket on the branch holds",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = (secondLogicalId: string) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const first = yield* Prisma.Bucket("First", { project, logicalId: "shared" });
        const second = yield* Prisma.Bucket("Second", { project, logicalId: secondLogicalId });
        return { project, first, second };
      });

    const initial = yield* stack.deploy(resources("second"));
    const failure = yield* failureOf(stack.deploy(resources("shared")));
    expect(failure.text).toContain("logical ID 'shared'");
    expect((yield* observeBucket(initial.first.bucketId)).logicalId).toBe("shared");

    yield* stack.destroy();
    yield* expectBucketGone(initial.first.bucketId);
    yield* expectBucketGone(initial.second.bucketId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "recreates a bucket deleted out of band on the next update and destroys one already gone",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(bucketStack({ name: "uploads" }));
    yield* deleteBucket({ bucketId: initial.bucket.bucketId });
    yield* expectBucketGone(initial.bucket.bucketId);

    const recreated = yield* stack.deploy(bucketStack({ name: "uploads-recreated" }));
    expect(recreated.bucket.bucketId).not.toBe(initial.bucket.bucketId);
    const observed = yield* observeBucket(recreated.bucket.bucketId);
    expect(observed.name).toBe("uploads-recreated");
    expect(observed.logicalId).toBe("Uploads");

    yield* deleteBucket({ bucketId: recreated.bucket.bucketId });
    yield* stack.destroy();
    yield* expectBucketGone(recreated.bucket.bucketId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "creates a key under its deterministic name and keeps its one-time secret",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(keyStack());
    expect(initial.key.bucketId).toBe(initial.first.bucketId);
    expect(Redacted.isRedacted(initial.key.secretAccessKey)).toBe(true);
    expect(Redacted.value(initial.key.secretAccessKey).length).toBeGreaterThan(0);
    expect(initial.key.accessKeyId.length).toBeGreaterThan(0);
    const keys = yield* listKeys(initial.first.bucketId);
    const observed = keys.find((key) => key.id === initial.key.bucketAccessKeyId);
    expect(observed?.name).toMatch(/^Key-[a-zA-Z0-9]{12}$/);
    expect(observed?.role).toBe("read_write");

    // The secret is revealed once; later deploys keep the persisted one.
    const repeated = yield* stack.deploy(keyStack());
    expect(repeated.key.bucketAccessKeyId).toBe(initial.key.bucketAccessKeyId);
    expect(Redacted.value(repeated.key.secretAccessKey)).toBe(
      Redacted.value(initial.key.secretAccessKey),
    );

    yield* stack.destroy();
    yield* expectBucketGone(initial.first.bucketId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: keyTags, timeout: 180_000 },
);

live.test.provider(
  "replaces a key when its role, name, or bucket changes",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(keyStack());
    const keyGone = (bucketId: string, keyId: string) =>
      expectGone(listKeys(bucketId).pipe(Effect.map((keys) => !keys.some((k) => k.id === keyId))));

    const byRole = yield* stack.deploy(keyStack({ role: "read" }));
    expect(byRole.key.bucketAccessKeyId).not.toBe(initial.key.bucketAccessKeyId);
    yield* keyGone(initial.first.bucketId, initial.key.bucketAccessKeyId);
    const readKey = (yield* listKeys(initial.first.bucketId)).find(
      (key) => key.id === byRole.key.bucketAccessKeyId,
    );
    expect(readKey?.role).toBe("read");

    const byName = yield* stack.deploy(keyStack({ role: "read", name: "reader" }));
    expect(byName.key.bucketAccessKeyId).not.toBe(byRole.key.bucketAccessKeyId);
    yield* keyGone(initial.first.bucketId, byRole.key.bucketAccessKeyId);
    const named = (yield* listKeys(initial.first.bucketId)).find(
      (key) => key.id === byName.key.bucketAccessKeyId,
    );
    expect(named?.name).toMatch(/^reader-[a-zA-Z0-9]{12}$/);

    const byBucket = yield* stack.deploy(
      keyStack({ role: "read", name: "reader", bucket: "second" }),
    );
    expect(byBucket.key.bucketId).toBe(initial.second.bucketId);
    yield* keyGone(initial.first.bucketId, byName.key.bucketAccessKeyId);
    expect(
      (yield* listKeys(initial.second.bucketId)).some(
        (key) => key.id === byBucket.key.bucketAccessKeyId,
      ),
    ).toBe(true);

    // A key revoked out of band does not block destroy.
    yield* deleteBucketKey({
      bucketId: initial.second.bucketId,
      keyId: byBucket.key.bucketAccessKeyId,
    });
    yield* stack.destroy();
    yield* expectBucketGone(initial.first.bucketId);
    yield* expectBucketGone(initial.second.bucketId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: keyTags, timeout: 240_000 },
);

live.test.provider(
  "revokes the orphaned key of an interrupted create before minting a fresh one",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(keyStack());
    // The key exists, but its one-time secret never reached state.
    yield* markCreating(stack, "Key");

    const recovered = yield* stack.deploy(keyStack());
    expect(recovered.key.bucketAccessKeyId).not.toBe(initial.key.bucketAccessKeyId);
    const keys = yield* listKeys(initial.first.bucketId);
    expect(keys.map((key) => key.id)).toEqual([recovered.key.bucketAccessKeyId]);

    yield* stack.destroy();
    yield* expectBucketGone(initial.first.bucketId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: keyTags, timeout: 180_000 },
);

live.test.provider(
  "refuses to recover a key when two keys share its deterministic name",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(keyStack());
    const name = (yield* listKeys(initial.first.bucketId)).find(
      (key) => key.id === initial.key.bucketAccessKeyId,
    )!.name;
    const duplicate = yield* createBucketKey({
      bucketId: initial.first.bucketId,
      name,
      role: "read",
    });
    yield* markCreating(stack, "Key");

    const failure = yield* failureOf(stack.deploy(keyStack()));
    expect(failure.errors.some((error) => error instanceof AmbiguousBucketAccessKeyError)).toBe(
      true,
    );
    // Neither key was revoked.
    const ids = (yield* listKeys(initial.first.bucketId)).map((key) => key.id);
    expect(ids).toContain(initial.key.bucketAccessKeyId);
    expect(ids).toContain(duplicate.data.id);

    yield* deleteBucketKey({ bucketId: initial.first.bucketId, keyId: duplicate.data.id });
    yield* stack.destroy();
    yield* expectBucketGone(initial.first.bucketId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: keyTags, timeout: 180_000 },
);
