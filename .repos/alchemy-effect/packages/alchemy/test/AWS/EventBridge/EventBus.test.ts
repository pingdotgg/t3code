import * as AWS from "@/AWS";
import { EventBus } from "@/AWS/EventBridge/EventBus.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { expect } from "alchemy-test";
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
  { timeout: 120_000 },
);
