import * as AWS from "@/AWS";
import { User } from "@/AWS/MemoryDB";
import * as Test from "@/Test/Alchemy";
import * as memorydb from "@distilled.cloud/aws/memorydb";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// A fixed test password (16-128 printable chars). Not a real secret.
const TEST_PASSWORD = Redacted.make("AlchemyMemoryDbTestPass01");

// MemoryDB user deletion takes ~2 minutes server-side. Deletion is verified
// as INITIATED (status `deleting`, irreversible) or fully gone — waiting for
// full disappearance would burn most of the test's timeout budget.
const assertDeletingOrGone = (name: string) =>
  Effect.gen(function* () {
    const status = yield* memorydb.describeUsers({ UserName: name }).pipe(
      Effect.map((r) => r.Users?.[0]?.Status ?? "gone"),
      Effect.catchTag("UserNotFoundFault", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (status !== "gone" && status !== "deleting") {
      return yield* Effect.fail(
        new Error(`user '${name}' still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(15),
      ]),
    }),
  );

test.provider(
  "create, update access string, delete a MemoryDB user",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { user } = yield* stack.deploy(
        Effect.gen(function* () {
          const user = yield* User("AppUser", {
            authenticationMode: {
              type: "password",
              passwords: [TEST_PASSWORD],
            },
            accessString: "on ~* +@all",
            tags: { fixture: "memorydb-user" },
          });
          return { user };
        }),
      );

      expect(user.userName).toBeDefined();
      expect(user.userArn).toContain(":user/");
      expect(user.accessString).toContain("~*");
      expect(user.authenticationType).toBe("password");

      // Out-of-band verification.
      const described = yield* memorydb.describeUsers({
        UserName: user.userName,
      });
      const observed = described.Users?.[0];
      expect(observed?.Status).toBe("active");
      expect(observed?.Authentication?.Type).toBe("password");

      // Update the access string in place (name unchanged).
      const { user: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const user = yield* User("AppUser", {
            authenticationMode: {
              type: "password",
              passwords: [TEST_PASSWORD],
            },
            accessString: "on ~app:* +@read",
            tags: { fixture: "memorydb-user", env: "test" },
          });
          return { user };
        }),
      );
      expect(updated.userName).toBe(user.userName);
      expect(updated.accessString).toContain("~app:*");

      const redescribed = yield* memorydb.describeUsers({
        UserName: user.userName,
      });
      expect(redescribed.Users?.[0]?.AccessString).toContain("~app:*");

      yield* stack.destroy();
      yield* assertDeletingOrGone(user.userName);
    }),
  { timeout: 240_000 },
);
