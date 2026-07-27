import * as AWS from "@/AWS";
import { App, Branch } from "@/AWS/Amplify";
import * as Test from "@/Test/Alchemy";
import * as amplify from "@distilled.cloud/aws/amplify";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { makeAmplifyTestLease } from "./TestLease.ts";

const { test, beforeAll, afterAll } = Test.make({ providers: AWS.providers() });
const testLease = makeAmplifyTestLease();

beforeAll(testLease.acquire, { timeout: 240_000 });
afterAll(testLease.release);

// base64 of "user:passw0rd" — generated once and checked in as a constant.
const BASIC_AUTH_CREDENTIALS = "dXNlcjpwYXNzdzByZA==";

const findBranch = (appId: string, branchName: string) =>
  amplify.getBranch({ appId, branchName }).pipe(
    Effect.map((r) => r.branch),
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
  );

class BranchStillExists extends Data.TaggedError("BranchStillExists")<{
  readonly branchName: string;
}> {}

const assertBranchDeleted = (appId: string, branchName: string) =>
  findBranch(appId, branchName).pipe(
    Effect.flatMap((branch) =>
      branch === undefined
        ? Effect.void
        : Effect.fail(new BranchStillExists({ branchName })),
    ),
    Effect.retry({
      while: (e) => e._tag === "BranchStillExists",
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(15),
      ]),
    }),
  );

test.provider(
  "create, update, and replace an Amplify branch",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (branchName: string, description: string) =>
        Effect.gen(function* () {
          const app = yield* App("BranchTestApp", {
            description: "Amplify Branch resource test app",
            platform: "WEB",
          });
          const branch = yield* Branch("TestBranch", {
            appId: app.appId,
            branchName,
            description,
            stage: "DEVELOPMENT",
            enableAutoBuild: false,
            ttl: "5 minutes",
            enableBasicAuth: true,
            basicAuthCredentials: Redacted.make(BASIC_AUTH_CREDENTIALS),
            environmentVariables: { STAGE: "test" },
            tags: { Environment: "test" },
          });
          return {
            appId: app.appId,
            branchName: branch.branchName,
            branchArn: branch.branchArn,
          };
        });

      const created = yield* stack.deploy(program("main", "initial"));
      expect(created.branchName).toBe("main");
      expect(created.branchArn).toContain("/branches/main");

      const live = yield* findBranch(created.appId, "main");
      expect(live?.description).toBe("initial");
      expect(live?.stage).toBe("DEVELOPMENT");
      expect(live?.enableAutoBuild).toBe(false);
      expect(live?.enableBasicAuth).toBe(true);
      // ttl is converted from the Duration input to wire seconds.
      expect(live?.ttl).toBe("300");
      expect(live?.environmentVariables?.STAGE).toBe("test");
      expect(live?.tags?.["alchemy::id"]).toBe("TestBranch");
      expect(live?.tags?.Environment).toBe("test");

      // Update in place — same branchName, changed mutable settings.
      const updated = yield* stack.deploy(program("main", "updated"));
      expect(updated.branchArn).toBe(created.branchArn);

      const live2 = yield* findBranch(created.appId, "main");
      expect(live2?.description).toBe("updated");

      // Replacement — changing branchName replaces the branch.
      const replaced = yield* stack.deploy(program("release", "initial"));
      expect(replaced.branchName).toBe("release");
      expect(replaced.branchArn).not.toBe(created.branchArn);
      yield* assertBranchDeleted(created.appId, "main");

      yield* stack.destroy();
      yield* assertBranchDeleted(created.appId, "release");
    }),
  { timeout: 240_000 },
);
