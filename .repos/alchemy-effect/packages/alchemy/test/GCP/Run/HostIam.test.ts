import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

/**
 * Host IAM plumbing without a container build: image-only hosts whose
 * Effect declares bindings. The bindings' IAM and env land on the host's
 * runtime service account even though the image is not Alchemy-built,
 * so this pins grant scoping, concurrent policy writes, revocation, and
 * account cleanup on any machine with GCP credentials.
 */

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const HELLO_IMAGE = "us-docker.pkg.dev/cloudrun/container/hello";

const Events = GCP.PubSub.Topic("IamEvents", {});
const Blobs = GCP.Storage.Bucket("IamBlobs", { forceDestroy: true });

class IamService extends GCP.Function<IamService>()(
  "IamService",
  {
    location: "us-central1",
    template: { containers: [{ image: HELLO_IMAGE }] },
  },
  Effect.gen(function* () {
    yield* GCP.PubSub.Publish(Events);
    yield* GCP.Storage.GetObject(Blobs);
    return {};
  }).pipe(
    Effect.provide(GCP.PubSub.PublishHttp),
    Effect.provide(GCP.Storage.GetObjectHttp),
  ),
) {}

class IamServicePublishOnly extends GCP.Function<IamServicePublishOnly>()(
  "IamService",
  {
    location: "us-central1",
    template: { containers: [{ image: HELLO_IMAGE }] },
  },
  Effect.gen(function* () {
    yield* GCP.PubSub.Publish(Events);
    yield* Blobs;
    return {};
  }).pipe(Effect.provide(GCP.PubSub.PublishHttp)),
) {}

// A second host granting on the same topic in the same deploy: both write
// the topic's IAM policy concurrently and must both land.
class IamJob extends GCP.Run.Job<IamJob>()(
  "IamJob",
  {
    location: "us-central1",
    containers: [{ image: HELLO_IMAGE }],
  },
  Effect.gen(function* () {
    yield* GCP.PubSub.Publish(Events);
    return {};
  }).pipe(Effect.provide(GCP.PubSub.PublishHttp)),
) {}

const membersOf = (
  policy: {
    bindings?: ReadonlyArray<{
      role?: string;
      members?: ReadonlyArray<string>;
    }>;
  },
  member: string,
) =>
  [
    ...new Set(
      (policy.bindings ?? [])
        .filter((binding) => (binding.members ?? []).includes(member))
        .flatMap((binding) => (binding.role ? [binding.role] : [])),
    ),
  ].sort();

test.provider(
  "bindings grant on the bound resource, converge concurrently, and revoke on removal",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (host: typeof IamService | typeof IamServicePublishOnly) =>
        stack.deploy(
          Effect.gen(function* () {
            const service = yield* host;
            const job = yield* IamJob;
            const topic = yield* Events;
            const bucket = yield* Blobs;
            return {
              project: service.project,
              serviceAccount: service.serviceAccount,
              managed: service.managedServiceAccount,
              grants: service.iamGrants,
              jobAccount: job.serviceAccount,
              topic: topic.name,
              bucket: bucket.bucketName,
            };
          }),
        );

      const out = yield* deploy(IamService);
      expect(out.managed).toEqual(true);
      expect(out.serviceAccount).toMatch(/^alch-/);
      expect(out.jobAccount).toMatch(/^alch-/);
      expect(out.jobAccount).not.toEqual(out.serviceAccount);
      const service = `serviceAccount:${out.serviceAccount}`;
      const job = `serviceAccount:${out.jobAccount}`;

      expect(
        membersOf(
          yield* resourcemanager.getIamPolicyProjects({
            resource: `projects/${out.project}`,
          }),
          service,
        ),
      ).toEqual([]);
      const topicPolicy = yield* pubsub.getIamPolicyProjectsTopics({
        resource: out.topic,
      });
      expect(membersOf(topicPolicy, service)).toEqual([
        "roles/pubsub.publisher",
      ]);
      expect(membersOf(topicPolicy, job)).toEqual(["roles/pubsub.publisher"]);
      expect(
        membersOf(
          yield* storage.getIamPolicyBuckets({ bucket: out.bucket }),
          service,
        ),
      ).toEqual(["roles/storage.objectViewer"]);
      expect(out.grants.map((grant) => grant.kind).sort()).toEqual([
        "pubsub.topic",
        "storage.bucket",
      ]);

      const next = yield* deploy(IamServicePublishOnly);
      expect(next.serviceAccount).toEqual(out.serviceAccount);
      expect(next.grants.map((grant) => grant.kind)).toEqual(["pubsub.topic"]);
      expect(
        membersOf(
          yield* storage.getIamPolicyBuckets({ bucket: out.bucket }),
          service,
        ),
      ).toEqual([]);
      expect(
        membersOf(
          yield* pubsub.getIamPolicyProjectsTopics({ resource: out.topic }),
          service,
        ),
      ).toEqual(["roles/pubsub.publisher"]);

      yield* stack.destroy();

      for (const email of [out.serviceAccount, out.jobAccount]) {
        const gone = yield* iam
          .getProjectsServiceAccounts({
            name: `projects/${out.project}/serviceAccounts/${email}`,
          })
          .pipe(
            Effect.as("found" as const),
            Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          );
        expect(gone).toEqual("gone");
      }
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 240_000 },
);
