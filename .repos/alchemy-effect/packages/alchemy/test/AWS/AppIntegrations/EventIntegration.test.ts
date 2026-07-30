import * as AWS from "@/AWS";
import { EventIntegration } from "@/AWS/AppIntegrations";
import * as Test from "@/Test/Alchemy";
import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getEventIntegration on a nonexistent name fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        appintegrations.getEventIntegration({
          Name: "alchemy-nonexistent-event-integration-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const assertGone = (name: string) =>
  appintegrations.getEventIntegration({ Name: name }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`event integration '${name}' still exists`)),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, update description, replace on source change, delete an event integration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { integration } = yield* stack.deploy(
        Effect.gen(function* () {
          const integration = yield* EventIntegration("PartnerEvents", {
            source: "aws.partner/examplepartner.com",
            eventBridgeBus: "default",
            description: "alchemy event integration",
            tags: { purpose: "alchemy-test" },
          });
          return { integration };
        }),
      );

      expect(integration.eventIntegrationName).toBeDefined();
      expect(integration.eventIntegrationArn).toContain(":event-integration/");
      expect(integration.eventBridgeBus).toBe("default");
      expect(integration.source).toBe("aws.partner/examplepartner.com");

      // Out-of-band verification via distilled.
      const observed = yield* appintegrations.getEventIntegration({
        Name: integration.eventIntegrationName,
      });
      expect(observed.Description).toBe("alchemy event integration");
      expect(observed.EventBridgeBus).toBe("default");
      expect(observed.EventFilter?.Source).toBe(
        "aws.partner/examplepartner.com",
      );
      expect(observed.Tags?.purpose).toBe("alchemy-test");

      // Update the description in place (name/arn stable).
      const { integration: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const integration = yield* EventIntegration("PartnerEvents", {
            source: "aws.partner/examplepartner.com",
            eventBridgeBus: "default",
            description: "alchemy event integration v2",
            tags: { purpose: "alchemy-test", phase: "two" },
          });
          return { integration };
        }),
      );
      expect(updated.eventIntegrationName).toBe(
        integration.eventIntegrationName,
      );
      expect(updated.eventIntegrationArn).toBe(integration.eventIntegrationArn);

      const reobserved = yield* appintegrations.getEventIntegration({
        Name: integration.eventIntegrationName,
      });
      expect(reobserved.Description).toBe("alchemy event integration v2");
      expect(reobserved.Tags?.phase).toBe("two");

      // Changing the source replaces the event integration (new physical
      // name via a fresh instance id).
      const { integration: replaced } = yield* stack.deploy(
        Effect.gen(function* () {
          const integration = yield* EventIntegration("PartnerEvents", {
            source: "aws.partner/otherpartner.com",
            eventBridgeBus: "default",
            description: "alchemy event integration v2",
          });
          return { integration };
        }),
      );
      expect(replaced.source).toBe("aws.partner/otherpartner.com");
      expect(replaced.eventIntegrationName).not.toBe(
        integration.eventIntegrationName,
      );

      // The replaced (old) integration is deleted.
      yield* assertGone(integration.eventIntegrationName);

      yield* stack.destroy();
      yield* assertGone(replaced.eventIntegrationName);
    }),
  { timeout: 240_000 },
);
