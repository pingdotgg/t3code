import * as AWS from "@/AWS";
import { Application } from "@/AWS/AppIntegrations";
import * as Test from "@/Test/Alchemy";
import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getApplication on a nonexistent id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        appintegrations.getApplication({
          Arn: "00000000-0000-0000-0000-000000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const assertGone = (arn: string) =>
  appintegrations.getApplication({ Arn: arn }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`application '${arn}' still exists`)),
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
  "create, update in place, replace on namespace change, delete an application",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { app } = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Application("AgentApp", {
            namespace: "com.alchemy.testapp",
            accessUrl: "https://example.com",
            description: "alchemy application",
            tags: { purpose: "alchemy-test" },
          });
          return { app };
        }),
      );

      expect(app.applicationId).toBeDefined();
      expect(app.applicationArn).toContain(":application/");
      expect(app.applicationName).toBeDefined();
      expect(app.namespace).toBe("com.alchemy.testapp");

      // Out-of-band verification via distilled.
      const observed = yield* appintegrations.getApplication({
        Arn: app.applicationArn,
      });
      expect(observed.Name).toBe(app.applicationName);
      expect(observed.Namespace).toBe("com.alchemy.testapp");
      expect(observed.Description).toBe("alchemy application");
      expect(
        observed.ApplicationSourceConfig?.ExternalUrlConfig?.AccessUrl,
      ).toBe("https://example.com");
      expect(observed.Tags?.purpose).toBe("alchemy-test");

      // Update description, access URL, and permissions in place (arn/id
      // stable).
      const { app: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Application("AgentApp", {
            namespace: "com.alchemy.testapp",
            accessUrl: "https://updated.example.com",
            description: "alchemy application v2",
            permissions: ["User.Details.View"],
            tags: { purpose: "alchemy-test", phase: "two" },
          });
          return { app };
        }),
      );
      expect(updated.applicationArn).toBe(app.applicationArn);
      expect(updated.applicationId).toBe(app.applicationId);

      const reobserved = yield* appintegrations.getApplication({
        Arn: app.applicationArn,
      });
      expect(reobserved.Description).toBe("alchemy application v2");
      expect(
        reobserved.ApplicationSourceConfig?.ExternalUrlConfig?.AccessUrl,
      ).toBe("https://updated.example.com");
      expect(reobserved.Permissions).toEqual(["User.Details.View"]);
      expect(reobserved.Tags?.phase).toBe("two");

      // Changing the namespace replaces the application.
      const { app: replaced } = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Application("AgentApp", {
            namespace: "com.alchemy.testapp.v2",
            accessUrl: "https://updated.example.com",
            description: "alchemy application v2",
          });
          return { app };
        }),
      );
      expect(replaced.namespace).toBe("com.alchemy.testapp.v2");
      expect(replaced.applicationArn).not.toBe(app.applicationArn);

      // The replaced (old) application is deleted.
      yield* assertGone(app.applicationArn);

      yield* stack.destroy();
      yield* assertGone(replaced.applicationArn);
    }),
  { timeout: 240_000 },
);
