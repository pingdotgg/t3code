import * as AWS from "@alchemy.run/aws";
import { EventBus } from "@alchemy.run/aws/EventBridge/EventBus";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { Region } from "@distilled.cloud/aws/Region";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

/** Typed wait-until-gone: poll describeEventBus until ResourceNotFoundException. */
const assertBusGone = Effect.fn(function* (name: string) {
  const gone = yield* eventbridge.describeEventBus({ Name: name }).pipe(
    Effect.map(() => false),
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (isGone): boolean => isGone,
      times: 10,
    }),
  );
  expect(gone).toBe(true);
});

// Canonical `list()` test (AWS account/region-scoped collection): deploy a real
// event bus, resolve the provider from context via the typed `findProvider`,
// call `list()`, and assert the deployed bus appears in the
// exhaustively-paginated result.
test.provider(
  "list enumerates the deployed event bus",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bus = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EventBus("ListEventBus", {
            name: "alchemy-test-eventbus-list",
          });
        }),
      );

      const provider = yield* Provider.findProvider(EventBus);
      const all = yield* provider.list();

      expect(all.some((b) => b.eventBusName === bus.eventBusName)).toBe(true);
      // The AWS-managed `default` bus must be excluded.
      expect(all.some((b) => b.eventBusName === "default")).toBe(false);

      yield* stack.destroy();

      yield* assertBusGone("alchemy-test-eventbus-list");
    }),
  {
    tags: ["provider:aws", "provider:aws:eventbridge", "live"],
    timeout: 120_000,
  },
);

const describeBusIn = (name: string, region: string) =>
  eventbridge.describeEventBus({ Name: name }).pipe(
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
    Effect.provideService(Region, Effect.succeed(region)),
  );

test.provider(
  "region places the bus in another region and changing it replaces the bus",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const home = yield* yield* Region;
      const other = home === "us-east-1" ? "us-east-2" : "us-east-1";

      const remote = yield* stack.deploy(EventBus("RegionalBus", { region: other }));
      expect(remote.eventBusArn).toContain(`:events:${other}:`);
      expect((yield* describeBusIn(remote.eventBusName, other))?.Arn).toBe(remote.eventBusArn);
      expect(yield* describeBusIn(remote.eventBusName, home)).toBeUndefined();

      // Moving the bus back to the stack's region replaces it.
      const local = yield* stack.deploy(EventBus("RegionalBus", {}));
      expect(local.eventBusArn).toContain(`:events:${home}:`);
      expect((yield* describeBusIn(local.eventBusName, home))?.Arn).toBe(local.eventBusArn);
      expect(yield* describeBusIn(remote.eventBusName, other)).toBeUndefined();

      yield* stack.destroy();
      expect(yield* describeBusIn(local.eventBusName, home)).toBeUndefined();
    }),
  {
    tags: ["provider:aws", "provider:aws:eventbridge", "live"],
    timeout: 120_000,
  },
);
