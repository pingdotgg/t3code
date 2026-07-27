import * as AWS from "@/AWS";
import { App } from "@/AWS/Amplify";
import * as Test from "@/Test/Alchemy";
import * as amplify from "@distilled.cloud/aws/amplify";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { makeAmplifyTestLease } from "./TestLease.ts";

const { test, beforeAll, afterAll } = Test.make({ providers: AWS.providers() });
const testLease = makeAmplifyTestLease();

beforeAll(testLease.acquire, { timeout: 240_000 });
afterAll(testLease.release);

const findApp = (appId: string) =>
  amplify.getApp({ appId }).pipe(
    Effect.map((r) => r.app),
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
  );

class AppStillExists extends Data.TaggedError("AppStillExists")<{
  readonly appId: string;
}> {}

const assertAppDeleted = (appId: string) =>
  findApp(appId).pipe(
    Effect.flatMap((app) =>
      app === undefined
        ? Effect.void
        : Effect.fail(new AppStillExists({ appId })),
    ),
    Effect.retry({
      while: (e) => e._tag === "AppStillExists",
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(15),
      ]),
    }),
  );

// Amplify apps normally connect a Git repository, but that requires an OAuth
// handshake (CodeConnections / personal token) that is human-in-the-loop and
// cannot be automated from infrastructure code. This test therefore exercises
// the repo-less path: create the app container, assert it exists, update it,
// and delete it. Connecting a repo + branches is a console/CLI follow-up.
test.provider(
  "create an Amplify app without a connected repo, update, and delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* App("TestAmplifyApp", {
            description: "initial description",
            platform: "WEB",
            environmentVariables: { STAGE: "test" },
            tags: { Environment: "test" },
          });
        }),
      );

      expect(app.appId).toBeDefined();
      expect(app.appArn).toContain(":apps/");
      expect(app.defaultDomain).toContain("amplifyapp.com");

      const live = yield* findApp(app.appId);
      expect(live?.description).toBe("initial description");
      expect(live?.repository ?? "").toBe("");
      expect(live?.tags?.["alchemy::id"]).toBe("TestAmplifyApp");

      // Update description + env vars.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* App("TestAmplifyApp", {
            description: "updated description",
            platform: "WEB",
            environmentVariables: { STAGE: "test", REGION: "us-west-2" },
            tags: { Environment: "test", Extra: "yes" },
          });
        }),
      );
      expect(updated.appId).toBe(app.appId);

      const live2 = yield* findApp(app.appId);
      expect(live2?.description).toBe("updated description");
      expect(live2?.environmentVariables?.REGION).toBe("us-west-2");
      expect(live2?.tags?.Extra).toBe("yes");

      yield* stack.destroy();
      yield* assertAppDeleted(app.appId);
    }),
  { timeout: 180_000 },
);
