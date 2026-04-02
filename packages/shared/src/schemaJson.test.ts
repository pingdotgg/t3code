import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { encodePrettyJsonEffect, getSchemaDescription, toJsonSchemaObject } from "./schemaJson";

it.effect("encodePrettyJsonEffect writes indented JSON", () =>
  Effect.gen(function* () {
    const encodePrettyJson = encodePrettyJsonEffect(
      Schema.Struct({
        provider: Schema.String,
        options: Schema.Struct({
          enabled: Schema.Boolean,
        }),
      }),
    );

    const encoded = yield* encodePrettyJson({
      provider: "codex",
      options: {
        enabled: true,
      },
    });

    assert.strictEqual(
      encoded,
      `{
  "provider": "codex",
  "options": {
    "enabled": true
  }
}`,
    );
  }),
);

it.effect("toJsonSchemaObject hoists descriptions from wrapper nodes", () =>
  Effect.sync(() => {
    const schema = toJsonSchemaObject(
      Schema.Struct({
        enabled: Schema.Boolean.annotate({
          description: "Whether the feature is enabled.",
        }).pipe(Schema.withDecodingDefault(() => false)),
        name: Schema.String.annotate({
          description: "Human-readable display name.",
        }).check(Schema.isMinLength(1)),
      }),
    ) as Record<string, unknown>;

    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const enabled = properties.enabled;
    const name = properties.name;

    assert.isDefined(enabled);
    assert.isDefined(name);
    assert.strictEqual(enabled.description, "Whether the feature is enabled.");
    assert.strictEqual(name.description, "Human-readable display name.");
  }),
);

it.effect("getSchemaDescription reads hoisted descriptions from wrapped schemas", () =>
  Effect.sync(() => {
    const enabled = Schema.Boolean.annotate({
      description: "Whether the feature is enabled.",
    }).pipe(Schema.withDecodingDefault(() => false));

    assert.strictEqual(getSchemaDescription(enabled), "Whether the feature is enabled.");
  }),
);
