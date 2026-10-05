import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as integrations from "@distilled.cloud/gcp/integrations_v1";
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

const location = "us-central1";

// Updating a Salesforce instance that points at a placeholder org fails with
// InternalServerError ("Unknown Error."); set
// GCP_TEST_INTEGRATIONS_SFDC=1 when the test org ids resolve to a real
// Salesforce org.
const runSfdcLifecycle = !!process.env.GCP_TEST_INTEGRATIONS_SFDC;

// Salesforce instances must reference at least one auth config ("Auth config
// is not present in the request" otherwise).
const sfdcCredential = {
  credentialType: "USERNAME_AND_PASSWORD" as const,
  usernameAndPassword: { username: "alchemy", password: "test-secret" },
};

const waitUntilGone = (name: string) =>
  integrations.getProjectsLocationsSfdcInstancesSfdcChannels({ name }).pipe(
    Effect.map((row) =>
      (row.deleteTime ?? "").length > 0
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsSfdcInstancesSfdcChannels on a missing channel fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        integrations.getProjectsLocationsSfdcInstancesSfdcChannels({
          name: `projects/${project}/locations/${location}/sfdcInstances/missing/sfdcChannels/alchemy-missing-channel`,
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

test.provider.skipIf(!runSfdcLifecycle)(
  "create, update, and delete an SFDC channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const auth = yield* GCP.Integrations.AuthConfig("SalesforceAuth", {
            location,
            decryptedCredential: sfdcCredential,
          });
          const instance = yield* GCP.Integrations.SfdcInstance("Salesforce", {
            authConfigId: [auth.authConfigId],
            location,
            displayName: "alchemy-sfdc-channel-parent",
            description: "channel parent",
            sfdcOrgId: "00Dxx0000000001",
          });
          const channel = yield* GCP.Integrations.SfdcInstancesSfdcChannel(
            "Events",
            {
              sfdcInstance: instance.name,
              location,
              displayName: "alchemy-channel",
              description: "account events",
              channelTopic: "/event/AlchemyTest__e",
            },
          );
          return { instance, channel };
        }),
      );

      expect(created.channel.sfdcChannelId).toEqual(expect.any(String));
      expect(created.channel.location).toEqual(location);
      expect(created.channel.sfdcInstance).toEqual(created.instance.name);
      expect(created.channel.name).toEqual(
        `${created.instance.name}/sfdcChannels/${created.channel.sfdcChannelId}`,
      );
      expect(created.channel.displayName).toEqual("alchemy-channel");
      expect(created.channel.description).toEqual("account events");
      expect(created.channel.channelTopic).toEqual("/event/AlchemyTest__e");

      const fetched =
        yield* integrations.getProjectsLocationsSfdcInstancesSfdcChannels({
          name: created.channel.name,
        });
      // The API echoes names keyed by project number.
      expect(fetched.name?.split("/").slice(2)).toEqual(
        created.channel.name.split("/").slice(2),
      );
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.channelTopic).toEqual("/event/AlchemyTest__e");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const auth = yield* GCP.Integrations.AuthConfig("SalesforceAuth", {
            location,
            decryptedCredential: sfdcCredential,
          });
          const instance = yield* GCP.Integrations.SfdcInstance("Salesforce", {
            authConfigId: [auth.authConfigId],
            sfdcInstanceId: created.instance.sfdcInstanceId,
            location,
            displayName: "alchemy-sfdc-channel-parent",
            description: "channel parent",
            sfdcOrgId: "00Dxx0000000001",
          });
          const channel = yield* GCP.Integrations.SfdcInstancesSfdcChannel(
            "Events",
            {
              sfdcInstance: instance.name,
              sfdcChannelId: created.channel.sfdcChannelId,
              location,
              displayName: "alchemy-channel-v2",
              description: "account events v2",
              channelTopic: "/event/AlchemyTestV2__e",
            },
          );
          return { instance, channel };
        }),
      );

      expect(updated.channel.name).toEqual(created.channel.name);
      expect(updated.channel.displayName).toEqual("alchemy-channel-v2");
      expect(updated.channel.description).toEqual("account events v2");
      expect(updated.channel.channelTopic).toEqual("/event/AlchemyTestV2__e");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.channel.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:integrations", "live"],
    timeout: 90_000,
  },
);
