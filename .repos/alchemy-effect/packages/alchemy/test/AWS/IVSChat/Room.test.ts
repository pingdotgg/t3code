import * as AWS from "@/AWS";
import { Room } from "@/AWS/IVSChat";
import * as Test from "@/Test/Alchemy";
import * as ivschat from "@distilled.cloud/aws/ivschat";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getRoom on a nonexistent ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const region = yield* yield* AWS.Region;
      const { Account } = yield* sts.getCallerIdentity({});
      const error = yield* Effect.flip(
        ivschat.getRoom({
          identifier: `arn:aws:ivschat:${region}:${Account}:room/AbCdEfGh1234`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 60_000 },
);

const assertRoomGone = (arn: string) =>
  Effect.gen(function* () {
    const room = yield* ivschat.getRoom({ identifier: arn }).pipe(
      Effect.map((r) => r.arn),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
    if (room !== undefined) {
      return yield* Effect.fail(new Error(`room '${arn}' still exists`));
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
    }),
  );

// Rooms are free and provision synchronously — the full lifecycle
// (create, no-op, update-in-place, destroy) runs ungated.
test.provider(
  "create, update, and destroy an IVS Chat room",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const props = {
        roomName: "alchemy-test-ivschat-room",
        maximumMessageRatePerSecond: 5,
        maximumMessageLength: 200,
        tags: { fixture: "ivschat-room" },
      };

      // Create.
      const created = yield* stack.deploy(Room("Chat", props));
      expect(created.roomName).toBe("alchemy-test-ivschat-room");
      expect(created.roomArn).toContain(":room/");
      expect(created.roomId).toBeDefined();

      // Out-of-band verification via distilled.
      const observed = yield* ivschat.getRoom({ identifier: created.roomArn });
      expect(observed.name).toBe("alchemy-test-ivschat-room");
      expect(observed.maximumMessageRatePerSecond).toBe(5);
      expect(observed.maximumMessageLength).toBe(200);
      expect(observed.tags?.fixture).toBe("ivschat-room");
      expect(observed.tags?.["alchemy::id"]).toBe("Chat");

      // No-op redeploy keeps the same room.
      const noop = yield* stack.deploy(Room("Chat", props));
      expect(noop.roomArn).toBe(created.roomArn);

      // Update in place — message limits and name are mutable; the ARN
      // must not change.
      const updated = yield* stack.deploy(
        Room("Chat", {
          ...props,
          roomName: "alchemy-test-ivschat-room-b",
          maximumMessageLength: 300,
        }),
      );
      expect(updated.roomArn).toBe(created.roomArn);
      expect(updated.roomName).toBe("alchemy-test-ivschat-room-b");

      const reobserved = yield* ivschat.getRoom({
        identifier: created.roomArn,
      });
      expect(reobserved.name).toBe("alchemy-test-ivschat-room-b");
      expect(reobserved.maximumMessageLength).toBe(300);

      // Destroy and verify out-of-band with a typed wait-until-gone.
      yield* stack.destroy();
      yield* assertRoomGone(created.roomArn);
    }),
  { timeout: 240_000 },
);
