import * as AWS from "@/AWS";
import { Blueprint } from "@/AWS/BedrockDataAutomation";
import * as Test from "@/Test/Alchemy";
import * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const unredact = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

// A deterministic, valid BDA blueprint schema (checked-in constant fixture).
const invoiceSchema = (instruction: string) =>
  JSON.stringify({
    $schema: "http://json-schema.org/draft-07/schema#",
    description: "Extract invoice fields",
    class: "invoice",
    type: "object",
    definitions: {},
    properties: {
      invoice_number: {
        type: "string",
        inferenceType: "explicit",
        instruction,
      },
    },
  });

const findBlueprint = (blueprintArn: string) =>
  bda.getBlueprint({ blueprintArn }).pipe(
    Effect.map((r) => r.blueprint),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

class BlueprintStillExists extends Data.TaggedError("BlueprintStillExists")<{
  readonly blueprintArn: string;
}> {}

const assertBlueprintDeleted = (blueprintArn: string) =>
  findBlueprint(blueprintArn).pipe(
    Effect.flatMap((blueprint) =>
      blueprint === undefined
        ? Effect.void
        : Effect.fail(new BlueprintStillExists({ blueprintArn })),
    ),
    Effect.retry({
      while: (e) => e._tag === "BlueprintStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getBlueprint on a nonexistent ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { Account } = yield* sts.getCallerIdentity({});
      const region = yield* Effect.sync(
        () => process.env.AWS_REGION ?? "us-west-2",
      );
      const error = yield* Effect.flip(
        bda.getBlueprint({
          blueprintArn: `arn:aws:bedrock:${region}:${Account}:blueprint/nonexistent-alchemy-probe`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "create, update schema, delete blueprint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const blueprint = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Blueprint("TestBlueprint", {
            type: "DOCUMENT",
            schema: invoiceSchema("The invoice number"),
            tags: { Environment: "test" },
          });
        }),
      );

      expect(blueprint.blueprintArn).toContain(":blueprint/");
      expect(blueprint.type).toBe("DOCUMENT");

      // out-of-band verification via distilled
      const created = yield* findBlueprint(blueprint.blueprintArn);
      expect(created).toBeDefined();
      expect(unredact(created!.blueprintName)).toBe(blueprint.blueprintName);
      expect(
        JSON.parse(unredact(created!.schema)).properties.invoice_number,
      ).toBeDefined();
      const tags = yield* bda
        .listTagsForResource({ resourceARN: blueprint.blueprintArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.tags ?? []).map((t) => [t.key, t.value])),
          ),
        );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("TestBlueprint");

      // update the schema in place — same physical blueprint
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Blueprint("TestBlueprint", {
            type: "DOCUMENT",
            schema: invoiceSchema("The unique invoice number on the header"),
            tags: { Environment: "test" },
          });
        }),
      );
      expect(updated.blueprintArn).toBe(blueprint.blueprintArn);

      const afterUpdate = yield* findBlueprint(blueprint.blueprintArn);
      expect(
        JSON.parse(unredact(afterUpdate!.schema)).properties.invoice_number
          .instruction,
      ).toBe("The unique invoice number on the header");

      yield* stack.destroy();
      yield* assertBlueprintDeleted(blueprint.blueprintArn);
    }),
  { timeout: 120_000 },
);

test.provider(
  "custom blueprint name and replacement on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Blueprint("NamedBlueprint", {
            blueprintName: "alchemy-test-blueprint-a",
            type: "DOCUMENT",
            schema: invoiceSchema("The invoice number"),
          });
        }),
      );
      expect(first.blueprintName).toBe("alchemy-test-blueprint-a");

      // renaming triggers a replacement: new physical blueprint, old one gone
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Blueprint("NamedBlueprint", {
            blueprintName: "alchemy-test-blueprint-b",
            type: "DOCUMENT",
            schema: invoiceSchema("The invoice number"),
          });
        }),
      );
      expect(second.blueprintName).toBe("alchemy-test-blueprint-b");
      expect(second.blueprintArn).not.toBe(first.blueprintArn);

      yield* assertBlueprintDeleted(first.blueprintArn);

      yield* stack.destroy();
      yield* assertBlueprintDeleted(second.blueprintArn);
    }),
  { timeout: 120_000 },
);
