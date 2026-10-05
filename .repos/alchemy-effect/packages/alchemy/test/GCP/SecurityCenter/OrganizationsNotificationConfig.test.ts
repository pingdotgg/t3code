import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  scc.getOrganizationsNotificationConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// Organization-level Security Command Center needs SCC activated on the
// organization and org-level SCC roles for the test identity. Set
// GCP_TEST_SECURITY_CENTER=1 and GOOGLE_ORGANIZATION_ID when both hold.
const organizationId = process.env.GOOGLE_ORGANIZATION_ID;
const runLifecycle = !!process.env.GCP_TEST_SECURITY_CENTER && !!organizationId;

const organizationOf = () =>
  Effect.succeed(
    organizationId === undefined
      ? ""
      : organizationId.startsWith("organizations/")
        ? organizationId
        : `organizations/${organizationId}`,
  );

test.provider(
  "getOrganizationsNotificationConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        scc.getOrganizationsNotificationConfigs({
          name: `${organization}/notificationConfigs/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securitycenter", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an organization notification config",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const organization = yield* organizationOf();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("OrgSccNotify", {});
          const config =
            yield* GCP.SecurityCenter.OrganizationsNotificationConfig("High", {
              organization,
              pubsubTopic: topic.name,
              description: "high severity",
              streamingConfig: { filter: 'severity="HIGH"' },
            });
          return { topic, config };
        }),
      );

      expect(created.config.configId).toEqual(expect.any(String));
      expect(created.config.organization).toEqual(organization);
      expect(created.config.name).toEqual(
        `${organization}/notificationConfigs/${created.config.configId}`,
      );
      expect(created.config.description).toEqual("high severity");

      const fetched = yield* scc.getOrganizationsNotificationConfigs({
        name: created.config.name,
      });
      expect(fetched.name).toEqual(created.config.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("OrgSccNotify", {
            topicId: created.topic.topicId,
          });
          const config =
            yield* GCP.SecurityCenter.OrganizationsNotificationConfig("High", {
              organization,
              configId: created.config.configId,
              pubsubTopic: topic.name,
              description: "high and critical",
              streamingConfig: {
                filter: 'severity="HIGH" OR severity="CRITICAL"',
              },
            });
          return { topic, config };
        }),
      );

      expect(updated.config.name).toEqual(created.config.name);
      expect(updated.config.description).toEqual("high and critical");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.config.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securitycenter", "live"],
    timeout: 90_000,
  },
);
