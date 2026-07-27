import * as AWS from "@/AWS";
import { LoggingConfiguration, Room } from "@/AWS/IVSChat";
import { LogGroup } from "@/AWS/Logs";
import * as Test from "@/Test/Alchemy";
import * as ivschat from "@distilled.cloud/aws/ivschat";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const assertLoggingConfigurationGone = (arn: string) =>
  Effect.gen(function* () {
    const config = yield* ivschat
      .getLoggingConfiguration({ identifier: arn })
      .pipe(
        Effect.map((r) => r.arn),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      );
    if (config !== undefined) {
      return yield* Effect.fail(
        new Error(`logging configuration '${arn}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
    }),
  );

// Covers create (CloudWatch Logs destination, waits for ACTIVE),
// attachment to a room, no-op, and destroy.
test.provider(
  "create, attach, and destroy an IVS Chat logging configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const logGroup = yield* LogGroup("ChatLogGroup", {
          logGroupName: "/alchemy-test/ivschat-logging",
          retention: "1 day",
        });
        const logging = yield* LoggingConfiguration("ChatLogs", {
          loggingConfigurationName: "alchemy-test-ivschat-logging",
          destinationConfiguration: {
            cloudWatchLogs: { logGroupName: logGroup.logGroupName },
          },
          tags: { fixture: "ivschat-logging" },
        });
        const room = yield* Room("LoggedChat", {
          roomName: "alchemy-test-ivschat-logged-room",
          loggingConfigurationIdentifiers: [logging.loggingConfigurationArn],
        });
        return { logging, room };
      });

      // Create.
      const created = yield* stack.deploy(program);
      expect(created.logging.loggingConfigurationName).toBe(
        "alchemy-test-ivschat-logging",
      );
      expect(created.logging.loggingConfigurationArn).toContain(
        ":logging-configuration/",
      );
      expect(created.logging.loggingConfigurationId).toBeDefined();
      expect(created.logging.state).toBe("ACTIVE");

      // Out-of-band verification via distilled.
      const observed = yield* ivschat.getLoggingConfiguration({
        identifier: created.logging.loggingConfigurationArn,
      });
      expect(observed.state).toBe("ACTIVE");
      expect(
        observed.destinationConfiguration &&
          "cloudWatchLogs" in observed.destinationConfiguration
          ? observed.destinationConfiguration.cloudWatchLogs?.logGroupName
          : undefined,
      ).toBe("/alchemy-test/ivschat-logging");
      expect(observed.tags?.["alchemy::id"]).toBe("ChatLogs");

      // The room is attached to the logging configuration.
      const observedRoom = yield* ivschat.getRoom({
        identifier: created.room.roomArn,
      });
      expect(observedRoom.loggingConfigurationIdentifiers).toContain(
        created.logging.loggingConfigurationArn,
      );

      // No-op redeploy keeps the same configuration.
      const noop = yield* stack.deploy(program);
      expect(noop.logging.loggingConfigurationArn).toBe(
        created.logging.loggingConfigurationArn,
      );

      // Destroy and verify out-of-band with a typed wait-until-gone.
      yield* stack.destroy();
      yield* assertLoggingConfigurationGone(
        created.logging.loggingConfigurationArn,
      );
    }),
  { timeout: 240_000 },
);
