import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudsupport from "@distilled.cloud/gcp/cloudsupport_v2";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Support event subscriptions need an organization-level Cloud Support role
// (Cloud Customer Care). The testing credentials hold none, so every call is
// rejected with Forbidden ("Permission 'cloudsupport.supportSubscriptions.get'
// denied ..."). Set GCP_TEST_CLOUDSUPPORT=1 on an entitled org to run the
// lifecycle.
const entitled = process.env.GCP_TEST_CLOUDSUPPORT === "1";
const runLifecycle = entitled && !process.env.FAST;

const waitUntilGone = (name: string) =>
  cloudsupport.getOrganizationsSupportEventSubscriptions({ name }).pipe(
    Effect.map((subscription) =>
      subscription.state === "DELETED" ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

/** The organization that owns the testing project. */
const organizationOf = () =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    const resource = yield* resourcemanager.getProjects({
      name: `projects/${project}`,
    });
    return resource.parent ?? "";
  });

test.provider(
  "getSupportEventSubscriptions on a missing subscription fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      const error = yield* Effect.flip(
        cloudsupport.getOrganizationsSupportEventSubscriptions({
          name: `${organization}/supportEventSubscriptions/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual(entitled ? "NotFound" : "Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudsupport", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(entitled)(
  "createSupportEventSubscriptions without Cloud Support access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const organization = yield* organizationOf();
      const error = yield* Effect.flip(
        cloudsupport.createOrganizationsSupportEventSubscriptions({
          parent: organization,
          body: {
            pubSubTopic: `projects/${project}/topics/alchemy-missing-topic`,
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudsupport", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a support event subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      expect(organization.length).toBeGreaterThan(0);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("SupportEventsA", {});
          const subscription = yield* GCP.CloudSupport.SupportEventSubscription(
            "Events",
            {
              organization,
              pubSubTopic: topic.name,
            },
          );
          return { topic, subscription };
        }),
      );

      expect(created.subscription.name).toContain(
        "/supportEventSubscriptions/",
      );
      expect(created.subscription.subscriptionId.length).toBeGreaterThan(0);
      expect(created.subscription.organization).toEqual(organization);
      expect(created.subscription.pubSubTopic).toEqual(created.topic.name);

      const fetched =
        yield* cloudsupport.getOrganizationsSupportEventSubscriptions({
          name: created.subscription.name,
        });
      expect(fetched.name).toEqual(created.subscription.name);
      expect(fetched.pubSubTopic).toEqual(created.topic.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topicA = yield* GCP.PubSub.Topic("SupportEventsA", {});
          const topicB = yield* GCP.PubSub.Topic("SupportEventsB", {});
          const subscription = yield* GCP.CloudSupport.SupportEventSubscription(
            "Events",
            {
              organization,
              subscriptionId: created.subscription.subscriptionId,
              pubSubTopic: topicB.name,
            },
          );
          return { topicA, topicB, subscription };
        }),
      );

      expect(updated.subscription.name).toEqual(created.subscription.name);
      expect(updated.subscription.pubSubTopic).toEqual(updated.topicB.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.subscription.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudsupport", "live"],
    timeout: 90_000,
  },
);
