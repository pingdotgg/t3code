import * as AWS from "@/AWS";
import { EventBus } from "@/AWS/EventBridge/EventBus.ts";
import { Permission } from "@/AWS/EventBridge/Permission.ts";
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

// Canonical `list()` test. An EventBridge Permission is a statement in an event
// bus resource policy (there is no list-permissions API). `list()` enumerates
// every bus, parses each bus's Policy JSON, and emits one Attributes per Sid.
// Deploy a bus + a permission, resolve the provider via the typed
// `findProvider`, call `list()`, and assert the deployed statement appears.
test.provider(
  "list enumerates the deployed permission",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const permission = yield* stack.deploy(
        Effect.gen(function* () {
          const bus = yield* EventBus("ListPermissionBus", {
            name: "alchemy-test-permission-list",
          });
          return yield* Permission("ListPermission", {
            eventBusName: bus.eventBusName,
            principal: "123456789012",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Permission);
      const all = yield* provider.list();

      expect(
        all.some(
          (p) =>
            p.statementId === permission.statementId &&
            p.eventBusName === permission.eventBusName,
        ),
      ).toBe(true);

      yield* stack.destroy();

      yield* assertBusGone("alchemy-test-permission-list");
    }),
  { timeout: 120_000 },
);
