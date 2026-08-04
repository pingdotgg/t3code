import * as AWS from "@/AWS";
import * as AppConfig from "@/AWS/AppConfig";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import * as Test from "@/Test/Alchemy";
import * as appconfig from "@distilled.cloud/aws/appconfig";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const getApp = (applicationId: string) =>
  appconfig
    .getApplication({ ApplicationId: applicationId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

const waitUntilAppGone = (applicationId: string) =>
  getApp(applicationId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (a) => a === undefined,
      times: 10,
    }),
  );

// Full AppConfig control-plane lifecycle in one stack: application ->
// environment -> hosted configuration profile -> hosted version, plus a
// standalone deployment strategy. Everything is fast and free. Update the
// application description in place, then destroy and verify out-of-band.
test.provider(
  "appconfig control plane: create the full chain, update, and destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (description: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* AppConfig.Application("App", {
              description,
              tags: { team: "platform" },
            });
            const env = yield* AppConfig.Environment("Env", {
              applicationId: app.applicationId,
            });
            const profile = yield* AppConfig.ConfigurationProfile("Profile", {
              applicationId: app.applicationId,
              locationUri: "hosted",
            });
            const version = yield* AppConfig.HostedConfigurationVersion("V1", {
              applicationId: app.applicationId,
              configurationProfileId: profile.configurationProfileId,
              content: JSON.stringify({ featureX: true }),
              contentType: "application/json",
            });
            const strategy = yield* AppConfig.DeploymentStrategy("Strategy", {
              deploymentDuration: 0,
              growthFactor: 100,
              finalBakeTime: 0,
              replicateTo: "NONE",
            });
            return {
              applicationId: app.applicationId.as<string>(),
              applicationArn: app.applicationArn.as<string>(),
              environmentId: env.environmentId.as<string>(),
              configurationProfileId:
                profile.configurationProfileId.as<string>(),
              versionNumber: version.versionNumber.as<number>(),
              strategyId: strategy.deploymentStrategyId.as<string>(),
            };
          }),
        );

      const created = yield* deploy("v1 description");
      expect(created.applicationId).toBeTruthy();
      expect(created.environmentId).toBeTruthy();
      expect(created.configurationProfileId).toBeTruthy();
      expect(created.versionNumber).toBe(1);
      expect(created.strategyId).toBeTruthy();

      // Out-of-band: the application exists and carries alchemy + user tags.
      const app = yield* getApp(created.applicationId);
      expect(app?.Description).toBe("v1 description");
      const tags = yield* appconfig.listTagsForResource({
        ResourceArn: created.applicationArn,
      });
      expect(tags.Tags?.["alchemy::id"]).toBe("App");
      expect(tags.Tags?.team).toBe("platform");

      // Out-of-band: the hosted version content round-trips.
      const version = yield* appconfig.getHostedConfigurationVersion({
        ApplicationId: created.applicationId,
        ConfigurationProfileId: created.configurationProfileId,
        VersionNumber: created.versionNumber,
      });
      const content = yield* Stream.mkString(
        Stream.decodeText(version.Content!),
      );
      expect(JSON.parse(content)).toEqual({ featureX: true });

      // Update the description in place — the application id is stable.
      const updated = yield* deploy("v2 description");
      expect(updated.applicationId).toBe(created.applicationId);
      const appAfter = yield* getApp(created.applicationId);
      expect(appAfter?.Description).toBe("v2 description");

      // Destroy — the application (and its children) are gone.
      yield* stack.destroy();
      const gone = yield* waitUntilAppGone(created.applicationId);
      expect(gone).toBeUndefined();
    }),
  { timeout: 240_000 },
);

// Extension + association lifecycle: an extension whose action emits
// deployment events to the default EventBridge bus (AppConfig EventBridge
// extension actions only support the default bus; no invoke role required),
// associated with the application. Update the extension description in
// place, then destroy and verify out-of-band.
test.provider(
  "appconfig extension: create, associate, update, and destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { accountId, region } = yield* AWSEnvironment.current;
      const defaultBusArn = `arn:aws:events:${region}:${accountId}:event-bus/default`;

      const deploy = (description: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* AppConfig.Application("ExtApp", {});
            const extension = yield* AppConfig.Extension("Ext", {
              description,
              actions: {
                ON_DEPLOYMENT_COMPLETE: [
                  { name: "notify-bus", uri: defaultBusArn },
                ],
              },
              tags: { team: "platform" },
            });
            const association = yield* AppConfig.ExtensionAssociation(
              "ExtAssoc",
              {
                extensionIdentifier: extension.extensionId,
                resourceIdentifier: app.applicationArn,
              },
            );
            return {
              extensionId: extension.extensionId.as<string>(),
              extensionArn: extension.extensionArn.as<string>(),
              versionNumber: extension.versionNumber.as<number>(),
              associationId: association.extensionAssociationId.as<string>(),
            };
          }),
        );

      const created = yield* deploy("v1 hook");
      expect(created.extensionId).toBeTruthy();
      expect(created.versionNumber).toBeGreaterThan(0);
      expect(created.associationId).toBeTruthy();

      // Out-of-band: the extension exists with the action and alchemy tags.
      const extension = yield* appconfig.getExtension({
        ExtensionIdentifier: created.extensionId,
      });
      expect(extension.Description).toBe("v1 hook");
      expect(extension.Actions?.ON_DEPLOYMENT_COMPLETE?.[0]?.Name).toBe(
        "notify-bus",
      );
      const tags = yield* appconfig.listTagsForResource({
        ResourceArn: created.extensionArn,
      });
      expect(tags.Tags?.["alchemy::id"]).toBe("Ext");

      // Out-of-band: the association binds the extension to the application.
      const association = yield* appconfig.getExtensionAssociation({
        ExtensionAssociationId: created.associationId,
      });
      expect(association.ExtensionArn).toBeTruthy();
      expect(association.ResourceArn).toContain(":application/");

      // Update the description in place — id and association are stable.
      const updated = yield* deploy("v2 hook");
      expect(updated.extensionId).toBe(created.extensionId);
      expect(updated.associationId).toBe(created.associationId);
      const after = yield* appconfig.getExtension({
        ExtensionIdentifier: created.extensionId,
      });
      expect(after.Description).toBe("v2 hook");

      // Destroy — association first, then the extension.
      yield* stack.destroy();
      const goneExtension = yield* appconfig
        .getExtension({ ExtensionIdentifier: created.extensionId })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (e): boolean => e === undefined,
            times: 10,
          }),
        );
      expect(goneExtension).toBeUndefined();
      const goneAssociation = yield* appconfig
        .getExtensionAssociation({
          ExtensionAssociationId: created.associationId,
        })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(goneAssociation).toBeUndefined();
    }),
  { timeout: 240_000 },
);
