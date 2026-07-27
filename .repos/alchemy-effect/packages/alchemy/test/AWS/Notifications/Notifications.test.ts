import * as AWS from "@/AWS";
import {
  ChannelAssociation,
  EventRule,
  NotificationConfiguration,
  NotificationHub,
} from "@/AWS/Notifications";
import { EmailContact } from "@/AWS/NotificationsContacts";
import { pinNotificationsRegion } from "@/AWS/Notifications/internal.ts";
import * as Test from "@/Test/Alchemy";
import * as notifications from "@distilled.cloud/aws/notifications";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const CONFIG_NAME = "alchemy-test-notif-config";
const CONFIG_NAME_RENAMED = "alchemy-test-notif-config-renamed";

const getConfig = (arn: string) =>
  pinNotificationsRegion(notifications.getNotificationConfiguration({ arn }));

const getRule = (arn: string) =>
  pinNotificationsRegion(notifications.getEventRule({ arn }));

const assertConfigGone = (arn: string) =>
  pinNotificationsRegion(
    notifications.getNotificationConfiguration({ arn }).pipe(
      Effect.flatMap(() =>
        Effect.fail(new Error(`configuration ${arn} still exists`)),
      ),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      Effect.retry({
        while: (e) => e instanceof Error,
        schedule: Schedule.max([
          Schedule.fixed("2 seconds"),
          Schedule.recurs(10),
        ]),
      }),
    ),
  );

const assertRuleGone = (arn: string) =>
  pinNotificationsRegion(
    notifications.getEventRule({ arn }).pipe(
      Effect.flatMap(() => Effect.fail(new Error(`rule ${arn} still exists`))),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      Effect.retry({
        while: (e) => e instanceof Error,
        schedule: Schedule.max([
          Schedule.fixed("2 seconds"),
          Schedule.recurs(10),
        ]),
      }),
    ),
  );

const listHubRegions = pinNotificationsRegion(
  notifications.listNotificationHubs.items({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).map((hub) => hub.notificationHubRegion),
    ),
  ),
);

describe("AWS.Notifications", () => {
  test.provider(
    "notification configuration + event rule lifecycle",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deploy = (props: {
          name: string;
          description: string;
          aggregationDuration: "LONG" | "SHORT" | "NONE";
          tags: Record<string, string>;
          rule: {
            eventType: string;
            eventPattern?: Record<string, any>;
            regions: string[];
          };
        }) =>
          stack.deploy(
            Effect.gen(function* () {
              const config = yield* NotificationConfiguration("Config", {
                name: props.name,
                description: props.description,
                aggregationDuration: props.aggregationDuration,
                tags: props.tags,
              });
              const rule = yield* EventRule("Rule", {
                notificationConfigurationArn:
                  config.notificationConfigurationArn,
                source: "aws.s3",
                eventType: props.rule.eventType,
                eventPattern: props.rule.eventPattern,
                regions: props.rule.regions,
              });
              return {
                configArn: config.notificationConfigurationArn,
                configName: config.name,
                configStatus: config.status,
                ruleArn: rule.eventRuleArn,
                ruleRegions: rule.regions,
              };
            }),
          );

        // CREATE
        const created = yield* deploy({
          name: CONFIG_NAME,
          description: "created by alchemy test",
          aggregationDuration: "SHORT",
          tags: { purpose: "alchemy-test" },
          rule: { eventType: "Object Created", regions: ["us-west-2"] },
        });
        expect(created.configArn).toContain(":configuration/");
        expect(created.configName).toBe(CONFIG_NAME);
        expect(created.ruleArn).toContain("/rule/");

        // Out-of-band: config, rule, and tags are live.
        const observed = yield* getConfig(created.configArn);
        expect(observed.name).toBe(CONFIG_NAME);
        expect(observed.description).toBe("created by alchemy test");
        expect(observed.aggregationDuration).toBe("SHORT");
        const observedRule = yield* getRule(created.ruleArn);
        expect(observedRule.source).toBe("aws.s3");
        expect(observedRule.eventType).toBe("Object Created");
        expect(observedRule.regions).toEqual(["us-west-2"]);
        const tags = yield* pinNotificationsRegion(
          notifications.listTagsForResource({ arn: created.configArn }),
        );
        expect(tags.tags?.purpose).toBe("alchemy-test");
        expect(tags.tags?.["alchemy::id"]).toBe("Config");

        // UPDATE — rename the config in place, change aggregation, widen the
        // rule with a pattern and a second region. ARNs must be stable.
        const updated = yield* deploy({
          name: CONFIG_NAME_RENAMED,
          description: "updated by alchemy test",
          aggregationDuration: "LONG",
          tags: { purpose: "alchemy-test", updated: "true" },
          rule: {
            eventType: "Object Created",
            eventPattern: { detail: { bucket: { name: ["alchemy-test"] } } },
            regions: ["us-west-2", "us-east-2"],
          },
        });
        expect(updated.configArn).toBe(created.configArn);
        expect(updated.ruleArn).toBe(created.ruleArn);
        const afterUpdate = yield* getConfig(created.configArn);
        expect(afterUpdate.name).toBe(CONFIG_NAME_RENAMED);
        expect(afterUpdate.description).toBe("updated by alchemy test");
        expect(afterUpdate.aggregationDuration).toBe("LONG");
        const ruleAfterUpdate = yield* getRule(created.ruleArn);
        expect([...ruleAfterUpdate.regions].sort()).toEqual([
          "us-east-2",
          "us-west-2",
        ]);
        expect(ruleAfterUpdate.eventPattern).toContain("alchemy-test");
        const tagsAfterUpdate = yield* pinNotificationsRegion(
          notifications.listTagsForResource({ arn: created.configArn }),
        );
        expect(tagsAfterUpdate.tags?.updated).toBe("true");

        // REPLACE — changing the event type replaces the rule (new ARN);
        // the config is untouched.
        const replaced = yield* deploy({
          name: CONFIG_NAME_RENAMED,
          description: "updated by alchemy test",
          aggregationDuration: "LONG",
          tags: { purpose: "alchemy-test", updated: "true" },
          rule: { eventType: "Object Deleted", regions: ["us-west-2"] },
        });
        expect(replaced.configArn).toBe(created.configArn);
        expect(replaced.ruleArn).not.toBe(created.ruleArn);
        const replacedRule = yield* getRule(replaced.ruleArn);
        expect(replacedRule.eventType).toBe("Object Deleted");
        yield* assertRuleGone(created.ruleArn);

        // DESTROY — everything gone, verified out-of-band.
        yield* stack.destroy();
        yield* assertRuleGone(replaced.ruleArn);
        yield* assertConfigGone(created.configArn);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "channel association lifecycle",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deploy = () =>
          stack.deploy(
            Effect.gen(function* () {
              const config = yield* NotificationConfiguration("ChannelConfig", {
                name: "alchemy-test-notif-channel-config",
                description: "channel association test",
              });
              const contact = yield* EmailContact("Contact", {
                name: "alchemy-test-notif-contact",
                emailAddress: "alchemy-test-notif-channel@example.com",
              });
              const association = yield* ChannelAssociation("Assoc", {
                notificationConfigurationArn:
                  config.notificationConfigurationArn,
                channelArn: contact.emailContactArn,
              });
              return {
                configArn: config.notificationConfigurationArn,
                contactArn: contact.emailContactArn,
                associatedChannel: association.channelArn,
              };
            }),
          );

        // CREATE — the association's channel is the contact.
        const created = yield* deploy();
        expect(created.associatedChannel).toBe(created.contactArn);

        // Out-of-band: the channel is associated with the configuration.
        const channels = yield* pinNotificationsRegion(
          notifications.listChannels({
            notificationConfigurationArn: created.configArn,
          }),
        );
        expect(channels.channels).toContain(created.contactArn);

        // Idempotent re-deploy (no change).
        const again = yield* deploy();
        expect(again.associatedChannel).toBe(created.contactArn);

        // DESTROY — association, contact and configuration all gone.
        yield* stack.destroy();
        yield* assertConfigGone(created.configArn);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "notification hub lifecycle",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // AWS refuses to deregister the last ACTIVE hub, so keep a baseline
        // hub (us-west-2) registered outside the stack. Registration is an
        // idempotent upsert, so this is a no-op when it already exists.
        yield* pinNotificationsRegion(
          notifications.registerNotificationHub({
            notificationHubRegion: "us-west-2",
          }),
        );

        const deployHub = (region: string) =>
          stack.deploy(
            Effect.gen(function* () {
              const hub = yield* NotificationHub("Hub", { region });
              return {
                region: hub.notificationHubRegion,
                status: hub.status,
              };
            }),
          );

        const created = yield* deployHub("us-east-2");
        expect(created.region).toBe("us-east-2");
        expect(created.status).toBe("ACTIVE");

        // Out-of-band: the hub is registered.
        expect(yield* listHubRegions).toContain("us-east-2");

        // Idempotent re-deploy (no change).
        const again = yield* deployHub("us-east-2");
        expect(again.region).toBe("us-east-2");

        // DESTROY — the stack hub deregisters; the baseline hub remains.
        yield* stack.destroy();
        const regions = yield* listHubRegions.pipe(
          Effect.repeat({
            schedule: Schedule.fixed("2 seconds"),
            until: (rs) => !rs.includes("us-east-2"),
            times: 15,
          }),
        );
        expect(regions).not.toContain("us-east-2");
        expect(regions).toContain("us-west-2");
      }),
    { timeout: 180_000 },
  );
});
