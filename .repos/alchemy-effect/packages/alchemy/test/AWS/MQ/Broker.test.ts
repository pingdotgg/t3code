import * as AWS from "@/AWS";
import { Broker } from "@/AWS/MQ";
import * as Test from "@/Test/Alchemy";
import * as mq from "@distilled.cloud/aws/mq";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled MQ error union carries the
// not-found tag the provider's observe/read/delete paths depend on.
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

const assertBrokerGone = (brokerId: string) =>
  Effect.gen(function* () {
    const status = yield* mq.describeBroker({ BrokerId: brokerId }).pipe(
      Effect.map((r) => r.BrokerState ?? "UNKNOWN"),
      Effect.catchTag("NotFoundException", () =>
        Effect.succeed("GONE" as const),
      ),
    );
    if (status !== "GONE") {
      return yield* Effect.fail(
        new Error(`MQ broker still exists (state: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(30),
      ]),
    }),
  );

// A broker bills per instance-hour and takes 5-10 min to provision, so the
// full lifecycle is gated behind AWS_TEST_SLOW=1 and always destroys. A
// single-instance mq.t3.micro ActiveMQ broker is the cheapest topology; with
// SubnetIds omitted, Amazon MQ places it in a default-VPC subnet.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create a single-instance ActiveMQ broker, verify RUNNING, destroy, verify gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const engines = yield* mq.describeBrokerEngineTypes({
        EngineType: "ACTIVEMQ",
      });
      const engineVersion =
        engines.BrokerEngineTypes?.[0]?.EngineVersions?.[0]?.Name;
      expect(engineVersion).toBeDefined();

      const broker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Broker("Orders", {
            brokerName: "alchemy-test-mq-broker",
            engineType: "ACTIVEMQ",
            engineVersion,
            hostInstanceType: "mq.t3.micro",
            deploymentMode: "SINGLE_INSTANCE",
            publiclyAccessible: true,
            users: [
              {
                username: "alchemyadmin",
                password: Redacted.make("SuperSecretPassw0rd!"),
              },
            ],
            tags: { team: "messaging" },
          });
        }),
      );

      expect(broker.brokerName).toBe("alchemy-test-mq-broker");
      expect(broker.brokerArn).toContain(":broker:");
      expect(broker.brokerState).toBe("RUNNING");
      expect(broker.endpoints).toBeDefined();
      expect(broker.endpoints!.length).toBeGreaterThan(0);

      // Out-of-band verification via distilled.
      const observed = yield* mq.describeBroker({ BrokerId: broker.brokerId });
      expect(observed.BrokerState).toBe("RUNNING");
      // MQ may echo the display casing ("ActiveMQ") rather than the request enum.
      expect(observed.EngineType?.toUpperCase()).toBe("ACTIVEMQ");
      expect(observed.HostInstanceType).toBe("mq.t3.micro");
      expect(observed.DeploymentMode).toBe("SINGLE_INSTANCE");
      expect(observed.Tags?.team).toBe("messaging");

      // Destroy immediately — a running broker bills per instance-hour.
      yield* stack.destroy();
      yield* assertBrokerGone(broker.brokerId);
    }),
  // create (~5-10 min) + delete (~3-5 min) + poll budget.
  { timeout: 1_200_000 },
);
