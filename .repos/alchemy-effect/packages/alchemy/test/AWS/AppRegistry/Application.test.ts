import * as AWS from "@/AWS";
import { Application } from "@/AWS/AppRegistry";
import * as Test from "@/Test/Alchemy";
import * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { makeAppRegistryTestLease } from "./TestLease.ts";

const { test, beforeAll, afterAll } = Test.make({ providers: AWS.providers() });
const serviceLease = makeAppRegistryTestLease();

beforeAll(serviceLease.acquire, { timeout: 3_600_000 });
afterAll(serviceLease.release);

class ApplicationStillExists extends Data.TaggedError(
  "ApplicationStillExists",
)<{ specifier: string }> {}

const assertApplicationGone = (specifier: string) =>
  appregistry.getApplication({ application: specifier }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new ApplicationStillExists({ specifier })),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ApplicationStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "creates, updates, replaces, and deletes an application",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Application("TestApp", {
            description: "application lifecycle test",
            tags: { purpose: "lifecycle" },
          });
          return {
            applicationId: app.applicationId,
            applicationArn: app.applicationArn,
            applicationName: app.applicationName,
          };
        }),
      );
      expect(created.applicationArn).toContain(":servicecatalog:");

      // out-of-band verify via distilled
      const found = yield* appregistry.getApplication({
        application: created.applicationId,
      });
      expect(found.name).toBe(created.applicationName);
      expect(found.description).toBe("application lifecycle test");
      expect(found.tags?.purpose).toBe("lifecycle");
      expect(found.tags?.["alchemy::id"]).toBe("TestApp");

      // in-place update of description + tags
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Application("TestApp", {
            description: "updated description",
            tags: { purpose: "lifecycle-updated" },
          });
        }),
      );
      const updated = yield* appregistry.getApplication({
        application: created.applicationId,
      });
      expect(updated.id).toBe(created.applicationId);
      expect(updated.description).toBe("updated description");
      expect(updated.tags?.purpose).toBe("lifecycle-updated");

      // explicit name change → replacement (new application ID)
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Application("TestApp", {
            applicationName: `${created.applicationName}-renamed`,
            description: "updated description",
          });
          return { applicationId: app.applicationId };
        }),
      );
      expect(replaced.applicationId).not.toBe(created.applicationId);
      yield* assertApplicationGone(created.applicationId);

      yield* stack.destroy();
      yield* assertApplicationGone(replaced.applicationId);
    }),
  { timeout: 180_000 },
);
