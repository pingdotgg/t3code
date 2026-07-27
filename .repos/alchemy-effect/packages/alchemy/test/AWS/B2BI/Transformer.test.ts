import * as AWS from "@/AWS";
import { Transformer } from "@/AWS/B2BI";
import * as Test from "@/Test/Alchemy";
import * as b2bi from "@distilled.cloud/aws/b2bi";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const assertTransformerGone = (transformerId: string) =>
  Effect.gen(function* () {
    const result = yield* b2bi.getTransformer({ transformerId }).pipe(
      Effect.map(() => "present" as const),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (result === "present") {
      return yield* Effect.fail(
        new Error(`Transformer '${transformerId}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(8)]),
    }),
  );

const inputConversion: b2bi.InputConversion = {
  fromFormat: "X12",
  formatOptions: {
    x12: { transactionSet: "X12_850", version: "VERSION_4010" },
  },
};

const mapping: b2bi.Mapping = {
  templateLanguage: "JSONATA",
  template: '{ "orderId": "test" }',
};

// Transformers are credential-free; the full lifecycle runs ungated.
test.provider(
  "create, update, activate, replace-on-active-change, and destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create (defaults to inactive).
      const created = yield* stack.deploy(
        Transformer("X12ToJson", {
          name: "alchemy-b2bi-transformer",
          inputConversion,
          mapping,
        }),
      );
      expect(created.transformerId).toMatch(/^tr-/);
      expect(created.name).toBe("alchemy-b2bi-transformer");
      expect(created.status).toBe("inactive");

      // Out-of-band verification.
      const described = yield* b2bi.getTransformer({
        transformerId: created.transformerId,
      });
      expect(described.name).toBe("alchemy-b2bi-transformer");

      // Update mapping template in place while inactive.
      const updated = yield* stack.deploy(
        Transformer("X12ToJson", {
          name: "alchemy-b2bi-transformer",
          inputConversion,
          mapping: {
            templateLanguage: "JSONATA",
            template: '{ "orderId": "updated" }',
          },
        }),
      );
      expect(updated.transformerId).toBe(created.transformerId);

      // Activate in place.
      const active = yield* stack.deploy(
        Transformer("X12ToJson", {
          name: "alchemy-b2bi-transformer",
          status: "active",
          inputConversion,
          mapping: {
            templateLanguage: "JSONATA",
            template: '{ "orderId": "updated" }',
          },
        }),
      );
      expect(active.transformerId).toBe(created.transformerId);
      expect(active.status).toBe("active");
      const reDescribed = yield* b2bi.getTransformer({
        transformerId: created.transformerId,
      });
      expect(reDescribed.status).toBe("active");

      // A config change on an ACTIVE transformer is a delete-first
      // replacement — B2BI rejects every update to an active transformer.
      const replaced = yield* stack.deploy(
        Transformer("X12ToJson", {
          name: "alchemy-b2bi-transformer",
          status: "active",
          inputConversion,
          mapping: {
            templateLanguage: "JSONATA",
            template: '{ "orderId": "replaced" }',
          },
        }),
      );
      expect(replaced.transformerId).not.toBe(created.transformerId);
      expect(replaced.status).toBe("active");
      yield* assertTransformerGone(created.transformerId);

      // Destroy (works even while active) and verify.
      yield* stack.destroy();
      yield* assertTransformerGone(replaced.transformerId);
    }),
  { timeout: 150_000 },
);
