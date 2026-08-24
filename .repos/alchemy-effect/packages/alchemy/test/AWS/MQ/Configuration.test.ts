import * as AWS from "@/AWS";
import { Configuration } from "@/AWS/MQ";
import * as Test from "@/Test/Alchemy";
import * as mq from "@distilled.cloud/aws/mq";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probes: prove the distilled MQ error union carries the
// not-found tag the providers' observe/read/delete paths depend on.
test.provider(
  "describeBroker on a nonexistent broker fails with NotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        mq.describeBroker({
          BrokerId: "b-00000000-0000-0000-0000-000000000000",
        }),
      );
      expect(error._tag).toBe("NotFoundException");
    }),
);

test.provider(
  "describeConfiguration on a nonexistent configuration fails with NotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        mq.describeConfiguration({
          ConfigurationId: "c-00000000-0000-0000-0000-000000000000",
        }),
      );
      expect(error._tag).toBe("NotFoundException");
    }),
);

const assertConfigurationGone = (configurationId: string) =>
  Effect.gen(function* () {
    const status = yield* mq
      .describeConfiguration({ ConfigurationId: configurationId })
      .pipe(
        Effect.map(() => "PRESENT" as const),
        Effect.catchTag("NotFoundException", () =>
          Effect.succeed("GONE" as const),
        ),
      );
    if (status !== "GONE") {
      return yield* Effect.fail(
        new Error(`MQ configuration ${configurationId} still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
    }),
  );

const configDataV1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<broker xmlns="http://activemq.apache.org/schema/core">
  <destinationPolicy>
    <policyMap>
      <policyEntries>
        <policyEntry topic=">">
          <pendingMessageLimitStrategy>
            <constantPendingMessageLimitStrategy limit="1000"/>
          </pendingMessageLimitStrategy>
        </policyEntry>
      </policyEntries>
    </policyMap>
  </destinationPolicy>
</broker>
`;

const configDataV2 = configDataV1.replace('limit="1000"', 'limit="2000"');

// A configuration is cheap and fast (no broker provisioning), so the full
// lifecycle runs ungated: create publishes revision 2 (custom data over the
// engine default), a data change publishes revision 3, then destroy.
test.provider(
  "create an ActiveMQ configuration, publish revisions on data change, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Pick a valid ActiveMQ engine version from the live API so the test
      // never breaks when AWS retires a hardcoded version.
      const engines = yield* mq.describeBrokerEngineTypes({
        EngineType: "ACTIVEMQ",
      });
      const engineVersion =
        engines.BrokerEngineTypes?.[0]?.EngineVersions?.[0]?.Name;
      expect(engineVersion).toBeDefined();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Configuration("BrokerConfig", {
            engineType: "ACTIVEMQ",
            engineVersion,
            description: "alchemy test config",
            data: configDataV1,
            tags: { team: "messaging" },
          });
        }),
      );

      expect(created.configurationArn).toContain(":configuration:");
      // MQ echoes the display casing ("ActiveMQ") rather than the request enum.
      expect(created.engineType.toUpperCase()).toBe("ACTIVEMQ");
      // createConfiguration seeds revision 1; publishing custom data -> 2.
      expect(created.configurationRevision).toBeGreaterThanOrEqual(2);

      // Out-of-band verification via distilled.
      const observed = yield* mq.describeConfiguration({
        ConfigurationId: created.configurationId,
      });
      expect(observed.Name).toBe(created.configurationName);
      expect(observed.Tags?.team).toBe("messaging");

      // A data change publishes a new revision.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Configuration("BrokerConfig", {
            engineType: "ACTIVEMQ",
            engineVersion,
            description: "alchemy test config v2",
            data: configDataV2,
            tags: { team: "messaging" },
          });
        }),
      );
      expect(updated.configurationId).toBe(created.configurationId);
      expect(updated.configurationRevision).toBeGreaterThan(
        created.configurationRevision,
      );

      yield* stack.destroy();
      yield* assertConfigurationGone(created.configurationId);
    }),
  { timeout: 180_000 },
);
