import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as integrations from "@distilled.cloud/gcp/integrations_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

// Product-scoped (`products/IP`) auth configs are rejected on a standard
// project with Forbidden ("User is not authorized to create AuthConfig with
// name … as they don't have membership of project {number}"), and product
// Salesforce instances need one. Set GCP_TEST_INTEGRATIONS_PRODUCT_AUTH=1 on a
// project entitled to the legacy product surface.
const runProductAuthLifecycle =
  !!process.env.GCP_TEST_INTEGRATIONS_PRODUCT_AUTH;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  integrations
    .getProjectsLocationsProductsSfdcInstancesSfdcChannels({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getProjectsLocationsProductsSfdcInstancesSfdcChannels on a missing channel fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        integrations.getProjectsLocationsProductsSfdcInstancesSfdcChannels({
          name: `projects/${project}/locations/us-central1/products/IP/sfdcInstances/alchemy-missing/sfdcChannels/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:integrations", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runProductAuthLifecycle)(
  "create, update, and delete a product Salesforce channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Integrations.ProductsSfdcInstance(
            "ProdOrg",
            {
              location: "us-central1",
              product: "IP",
              displayName: "alchemy-channel-org",
              description: "channel parent",
              sfdcOrgId: "00D000000000002",
              serviceAuthority: "https://example.my.salesforce.com",
            },
          );
          const channel =
            yield* GCP.Integrations.ProductsSfdcInstancesSfdcChannel("Orders", {
              sfdcInstance: instance.name,
              location: "us-central1",
              product: "IP",
              displayName: "alchemy-orders",
              description: "orders channel",
              channelTopic: "/event/AlchemyOrder__e",
            });
          return { instance, channel };
        }),
      );

      expect(created.channel.name).toContain("/sfdcChannels/");
      expect(created.channel.displayName).toEqual("alchemy-orders");
      expect(created.channel.description).toEqual("orders channel");
      expect(created.channel.channelTopic).toEqual("/event/AlchemyOrder__e");

      const fetched =
        yield* integrations.getProjectsLocationsProductsSfdcInstancesSfdcChannels(
          { name: created.channel.name },
        );
      expect(fetched.name).toEqual(created.channel.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Integrations.ProductsSfdcInstance(
            "ProdOrg",
            {
              sfdcInstanceId: created.instance.sfdcInstanceId,
              location: "us-central1",
              product: "IP",
              displayName: "alchemy-channel-org",
              description: "channel parent",
              sfdcOrgId: "00D000000000002",
              serviceAuthority: "https://example.my.salesforce.com",
            },
          );
          const channel =
            yield* GCP.Integrations.ProductsSfdcInstancesSfdcChannel("Orders", {
              sfdcInstance: instance.name,
              sfdcChannelId: created.channel.sfdcChannelId,
              location: "us-central1",
              product: "IP",
              displayName: "alchemy-orders",
              description: "updated channel",
              channelTopic: "/event/AlchemyOrder__e",
            });
          return { instance, channel };
        }),
      );

      expect(updated.channel.name).toEqual(created.channel.name);
      expect(updated.channel.description).toEqual("updated channel");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.channel.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:integrations", "live"],
    timeout: 90_000,
  },
);
