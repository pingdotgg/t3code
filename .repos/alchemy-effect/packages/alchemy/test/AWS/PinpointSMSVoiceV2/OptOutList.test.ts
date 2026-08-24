import * as AWS from "@/AWS";
import { OptOutList } from "@/AWS/PinpointSMSVoiceV2";
import * as Test from "@/Test/Alchemy";
import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/observe paths depend on.
test.provider(
  "describeOptOutLists on a nonexistent name fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        smsvoice.describeOptOutLists({
          OptOutListNames: ["alchemy-nonexistent-opt-out-list-probe"],
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 60_000 },
);

const getOptOutList = (name: string) =>
  smsvoice.describeOptOutLists({ OptOutListNames: [name] }).pipe(
    Effect.map((r) => r.OptOutLists?.[0]),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

const assertOptOutListGone = (name: string) =>
  Effect.gen(function* () {
    const found = yield* getOptOutList(name);
    if (found !== undefined) {
      return yield* Effect.fail(
        new Error(`opt-out list '${name}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
    }),
  );

// Opt-out lists are free and provision synchronously — the full lifecycle
// (create, no-op, tag update, destroy) runs ungated.
test.provider(
  "create, update tags, and destroy an opt-out list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const props = {
        optOutListName: "alchemy-test-smsvoice-opt-out-list",
        tags: { fixture: "smsvoice-opt-out-list" },
      };

      // Create.
      const created = yield* stack.deploy(OptOutList("OptOuts", props));
      expect(created.optOutListName).toBe("alchemy-test-smsvoice-opt-out-list");
      expect(created.optOutListArn).toContain(":opt-out-list/");

      // Out-of-band verification via distilled.
      const observed = yield* getOptOutList(created.optOutListName);
      expect(observed?.OptOutListName).toBe(created.optOutListName);
      const tags = yield* smsvoice.listTagsForResource({
        ResourceArn: created.optOutListArn,
      });
      const tagRecord = Object.fromEntries(
        (tags.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagRecord.fixture).toBe("smsvoice-opt-out-list");
      expect(tagRecord["alchemy::id"]).toBe("OptOuts");

      // No-op redeploy keeps the same list.
      const noop = yield* stack.deploy(OptOutList("OptOuts", props));
      expect(noop.optOutListArn).toBe(created.optOutListArn);

      // Tag update in place — the ARN must not change.
      const updated = yield* stack.deploy(
        OptOutList("OptOuts", {
          ...props,
          tags: { fixture: "smsvoice-opt-out-list-v2", extra: "1" },
        }),
      );
      expect(updated.optOutListArn).toBe(created.optOutListArn);
      const retags = yield* smsvoice.listTagsForResource({
        ResourceArn: created.optOutListArn,
      });
      const retagRecord = Object.fromEntries(
        (retags.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(retagRecord.fixture).toBe("smsvoice-opt-out-list-v2");
      expect(retagRecord.extra).toBe("1");

      // Destroy and verify out-of-band with a typed wait-until-gone.
      yield* stack.destroy();
      yield* assertOptOutListGone(created.optOutListName);
    }),
  { timeout: 240_000 },
);
