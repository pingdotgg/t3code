import * as AWS from "@/AWS";
import { ConfigurationSet } from "@/AWS/PinpointSMSVoiceV2";
import * as Test from "@/Test/Alchemy";
import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/observe paths depend on.
test.provider(
  "describeConfigurationSets on a nonexistent name fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        smsvoice.describeConfigurationSets({
          ConfigurationSetNames: ["alchemy-nonexistent-config-set-probe"],
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 60_000 },
);

const getConfigSet = (name: string) =>
  smsvoice.describeConfigurationSets({ ConfigurationSetNames: [name] }).pipe(
    Effect.map((r) => r.ConfigurationSets?.[0]),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

const assertConfigSetGone = (name: string) =>
  Effect.gen(function* () {
    const found = yield* getConfigSet(name);
    if (found !== undefined) {
      return yield* Effect.fail(
        new Error(`configuration set '${name}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
    }),
  );

// Configuration sets are free and provision synchronously — the full
// lifecycle (create, no-op, update-in-place, destroy) runs ungated.
test.provider(
  "create, update, and destroy a configuration set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const props = {
        configurationSetName: "alchemy-test-smsvoice-config-set",
        tags: { fixture: "smsvoice-config-set" },
      };

      // Create.
      const created = yield* stack.deploy(ConfigurationSet("Config", props));
      expect(created.configurationSetName).toBe(
        "alchemy-test-smsvoice-config-set",
      );
      expect(created.configurationSetArn).toContain(":configuration-set/");

      // Out-of-band verification via distilled.
      const observed = yield* getConfigSet(created.configurationSetName);
      expect(observed?.ConfigurationSetName).toBe(created.configurationSetName);
      expect(observed?.DefaultMessageType).toBeUndefined();
      const tags = yield* smsvoice.listTagsForResource({
        ResourceArn: created.configurationSetArn,
      });
      const tagRecord = Object.fromEntries(
        (tags.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagRecord.fixture).toBe("smsvoice-config-set");
      expect(tagRecord["alchemy::id"]).toBe("Config");

      // No-op redeploy keeps the same configuration set.
      const noop = yield* stack.deploy(ConfigurationSet("Config", props));
      expect(noop.configurationSetArn).toBe(created.configurationSetArn);

      // Update in place — set a default message type and change a tag; the
      // ARN must not change.
      const updated = yield* stack.deploy(
        ConfigurationSet("Config", {
          ...props,
          defaultMessageType: "TRANSACTIONAL",
          tags: { fixture: "smsvoice-config-set-v2" },
        }),
      );
      expect(updated.configurationSetArn).toBe(created.configurationSetArn);
      const reobserved = yield* getConfigSet(created.configurationSetName);
      expect(reobserved?.DefaultMessageType).toBe("TRANSACTIONAL");
      const retags = yield* smsvoice.listTagsForResource({
        ResourceArn: created.configurationSetArn,
      });
      expect(
        Object.fromEntries((retags.Tags ?? []).map((t) => [t.Key, t.Value]))
          .fixture,
      ).toBe("smsvoice-config-set-v2");

      // Removing the prop clears the default message type.
      yield* stack.deploy(ConfigurationSet("Config", props));
      const cleared = yield* getConfigSet(created.configurationSetName);
      expect(cleared?.DefaultMessageType).toBeUndefined();

      // Destroy and verify out-of-band with a typed wait-until-gone.
      yield* stack.destroy();
      yield* assertConfigSetGone(created.configurationSetName);
    }),
  { timeout: 240_000 },
);
