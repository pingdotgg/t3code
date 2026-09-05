import * as AWS from "@/AWS";
import { LogGroup } from "@/AWS/Logs";
import { AccessLogSubscription, ServiceNetwork } from "@/AWS/VpcLattice";
import * as Test from "@/Test/Alchemy";
import * as vpclattice from "@distilled.cloud/aws/vpc-lattice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// CloudWatch log-group destination ARNs round-trip through the lattice API
// with a trailing `:*`.
const normalizeArn = (arn: string) => arn.replace(/:\*$/, "");

test.provider(
  "create, update destination, delete an access log subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (destination: "primary" | "secondary") =>
        Effect.gen(function* () {
          const network = yield* ServiceNetwork("LogsNetwork", {});
          const primary = yield* LogGroup("LatticeLogsPrimary", {
            retention: "1 days",
          });
          const secondary = yield* LogGroup("LatticeLogsSecondary", {
            retention: "1 days",
          });
          const subscription = yield* AccessLogSubscription("NetworkLogs", {
            resourceIdentifier: network.serviceNetworkId,
            destinationArn:
              destination === "primary"
                ? primary.logGroupArn
                : secondary.logGroupArn,
          });
          return { network, primary, secondary, subscription };
        });

      const first = yield* stack.deploy(program("primary"));

      expect(first.subscription.accessLogSubscriptionId).toMatch(/^als-/);
      expect(normalizeArn(first.subscription.destinationArn)).toBe(
        normalizeArn(first.primary.logGroupArn),
      );

      const live = yield* vpclattice.getAccessLogSubscription({
        accessLogSubscriptionIdentifier:
          first.subscription.accessLogSubscriptionId,
      });
      expect(normalizeArn(live.destinationArn)).toBe(
        normalizeArn(first.primary.logGroupArn),
      );
      expect(live.resourceId).toBe(first.network.serviceNetworkId);

      // Update the destination in place (same destination type).
      const second = yield* stack.deploy(program("secondary"));
      expect(second.subscription.accessLogSubscriptionId).toBe(
        first.subscription.accessLogSubscriptionId,
      );
      const updated = yield* vpclattice.getAccessLogSubscription({
        accessLogSubscriptionIdentifier:
          first.subscription.accessLogSubscriptionId,
      });
      expect(normalizeArn(updated.destinationArn)).toBe(
        normalizeArn(first.secondary.logGroupArn),
      );

      yield* stack.destroy();
      const gone = yield* vpclattice
        .getAccessLogSubscription({
          accessLogSubscriptionIdentifier:
            first.subscription.accessLogSubscriptionId,
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(gone).toBe(true);
    }).pipe(Effect.ensuring(Effect.ignore(stack.destroy()))),
  { timeout: 300_000 },
);
