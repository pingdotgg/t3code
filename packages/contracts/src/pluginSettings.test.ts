import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  findPluginSettingsSchemaViolations,
  fingerprintSettingsSchema,
  type SettingsSchema,
} from "./pluginSettings.ts";
import {
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  GrokSettings,
  OpenCodeSettings,
} from "./settings.ts";

const withControl = <S extends Schema.Top>(schema: S, control: "text" | "password" | "switch") =>
  schema.pipe(Schema.annotate({ providerSettingsForm: { control } }));

describe("findPluginSettingsSchemaViolations", () => {
  it("accepts string fields with text-ish controls and boolean fields with switch", () => {
    const schema = Schema.Struct({
      token: withControl(Schema.String, "password"),
      baseUrl: withControl(Schema.String, "text"),
      enabled: withControl(Schema.Boolean, "switch"),
    }) as unknown as SettingsSchema;
    expect(findPluginSettingsSchemaViolations(schema)).toEqual([]);
  });

  it("accepts a string field with no annotation (control defaults to text)", () => {
    const schema = Schema.Struct({ baseUrl: Schema.String }) as unknown as SettingsSchema;
    expect(findPluginSettingsSchemaViolations(schema)).toEqual([]);
  });

  // The renderer would draw these as text boxes, read them as "", and every write
  // it produced would fail server validation. Rejecting at registration converts a
  // silent permanent mis-render into an actionable error.
  it("rejects a Number field (renderer has no numeric control)", () => {
    const schema = Schema.Struct({ retries: Schema.Number }) as unknown as SettingsSchema;
    const violations = findPluginSettingsSchemaViolations(schema);
    expect(violations.map((violation) => violation.field)).toEqual(["retries"]);
  });

  it("rejects an Array field", () => {
    const schema = Schema.Struct({
      hosts: Schema.Array(Schema.String),
    }) as unknown as SettingsSchema;
    expect(findPluginSettingsSchemaViolations(schema).map((v) => v.field)).toEqual(["hosts"]);
  });

  it("rejects a nested Struct field", () => {
    const schema = Schema.Struct({
      nested: Schema.Struct({ inner: Schema.String }),
    }) as unknown as SettingsSchema;
    expect(findPluginSettingsSchemaViolations(schema).map((v) => v.field)).toEqual(["nested"]);
  });

  it("rejects a switch control on a string field (control/type mismatch)", () => {
    const schema = Schema.Struct({
      enabled: withControl(Schema.String, "switch"),
    }) as unknown as SettingsSchema;
    expect(findPluginSettingsSchemaViolations(schema).map((v) => v.field)).toEqual(["enabled"]);
  });

  it("rejects a text control on a boolean field (control/type mismatch)", () => {
    const schema = Schema.Struct({
      enabled: withControl(Schema.Boolean, "text"),
    }) as unknown as SettingsSchema;
    expect(findPluginSettingsSchemaViolations(schema).map((v) => v.field)).toEqual(["enabled"]);
  });

  // Reports every bad field at once so an author fixes the schema in one pass.
  it("reports all violations, not just the first", () => {
    const schema = Schema.Struct({
      ok: Schema.String,
      retries: Schema.Number,
      hosts: Schema.Array(Schema.String),
    }) as unknown as SettingsSchema;
    expect(
      findPluginSettingsSchemaViolations(schema)
        .map((v) => v.field)
        .sort(),
    ).toEqual(["hosts", "retries"]);
  });

  // optionalKey puts annotations on the KEY, not the value: resolving only the
  // value loses `control` and the field silently falls back to "text".
  it("reads the control annotation off optionalKey fields", () => {
    const schema = Schema.Struct({
      enabled: Schema.optionalKey(withControl(Schema.Boolean, "switch")),
    }) as unknown as SettingsSchema;
    expect(findPluginSettingsSchemaViolations(schema)).toEqual([]);
  });

  // Every first-party provider parks non-renderable state (enabled: Boolean,
  // customModels: Array) behind hidden:true. Validating hidden fields against the
  // control vocabulary would reject all five real provider schemas.
  //
  // They carry decoding defaults, which is what makes them satisfiable without the
  // form. A hidden field with NO default is a different case and IS rejected — see
  // "hidden field configurability" below.
  it("ignores the TYPE of hidden fields that decoding can satisfy", () => {
    const schema = Schema.Struct({
      shown: Schema.String,
      customModels: Schema.Array(Schema.String).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
        Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
      ),
      retries: Schema.Number.pipe(
        Schema.withDecodingDefault(Effect.succeed(3)),
        Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
      ),
    }) as unknown as SettingsSchema;
    expect(findPluginSettingsSchemaViolations(schema)).toEqual([]);
  });

  it("accepts every real provider settings schema", () => {
    for (const [name, schema] of Object.entries({
      ClaudeSettings,
      CodexSettings,
      CursorSettings,
      GrokSettings,
      OpenCodeSettings,
    })) {
      expect(
        findPluginSettingsSchemaViolations(schema as unknown as SettingsSchema),
        `${name} must satisfy the renderable vocabulary`,
      ).toEqual([]);
    }
  });

  it("accepts fields carrying a decoding default", () => {
    const schema = Schema.Struct({
      baseUrl: Schema.String.pipe(
        Schema.withDecodingDefault(Effect.succeed("https://example.com")),
      ),
    }) as unknown as SettingsSchema;
    expect(findPluginSettingsSchemaViolations(schema)).toEqual([]);
  });
});

describe("hidden field configurability", () => {
  // A hidden field the form cannot supply, and decoding cannot fill in, makes the
  // plugin permanently unconfigurable: the form omits it, so every save fails
  // validation forever with no way for the user to fix it.
  it("rejects a hidden field that is required with no decoding default", () => {
    const schema = Schema.Struct({
      shown: Schema.String,
      token: Schema.String.pipe(Schema.annotateKey({ providerSettingsForm: { hidden: true } })),
    }) as unknown as SettingsSchema;
    expect(findPluginSettingsSchemaViolations(schema).map((v) => v.field)).toEqual(["token"]);
  });

  // This is how every first-party provider parks non-renderable state, so it must
  // stay legal — the default is what makes the field satisfiable without the form.
  it("accepts a hidden field carrying a decoding default", () => {
    const schema = Schema.Struct({
      shown: Schema.String,
      customModels: Schema.Array(Schema.String).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
        Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
      ),
    }) as unknown as SettingsSchema;
    expect(findPluginSettingsSchemaViolations(schema)).toEqual([]);
  });

  it("accepts a hidden optional field", () => {
    const schema = Schema.Struct({
      shown: Schema.String,
      note: Schema.optionalKey(
        Schema.String.pipe(Schema.annotateKey({ providerSettingsForm: { hidden: true } })),
      ),
    }) as unknown as SettingsSchema;
    expect(findPluginSettingsSchemaViolations(schema)).toEqual([]);
  });
});

describe("fingerprintSettingsSchema", () => {
  const base = Schema.Struct({
    baseUrl: Schema.String,
    shout: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  }) as unknown as SettingsSchema;

  // The whole point: a doc-only plugin update must not mark every user's stored
  // settings incompatible. Raw JSON.stringify of the JSON Schema did exactly that,
  // bricking configuration on a description edit.
  it("is unchanged by a description-only edit", () => {
    const documented = Schema.Struct({
      baseUrl: Schema.String.pipe(Schema.annotateKey({ description: "Where to reach the API." })),
      shout: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    }) as unknown as SettingsSchema;
    expect(fingerprintSettingsSchema(documented)).toBe(fingerprintSettingsSchema(base));
  });

  it("is unchanged by a title or control annotation", () => {
    const annotated = Schema.Struct({
      baseUrl: Schema.String.pipe(
        Schema.annotateKey({ title: "Base URL", providerSettingsForm: { control: "text" } }),
      ),
      shout: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    }) as unknown as SettingsSchema;
    expect(fingerprintSettingsSchema(annotated)).toBe(fingerprintSettingsSchema(base));
  });

  // Field order affects nothing about decoding.
  it("is unchanged by field reordering", () => {
    const reordered = Schema.Struct({
      shout: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
      baseUrl: Schema.String,
    }) as unknown as SettingsSchema;
    expect(fingerprintSettingsSchema(reordered)).toBe(fingerprintSettingsSchema(base));
  });

  it("changes when a field's encoded type changes", () => {
    const retyped = Schema.Struct({
      baseUrl: Schema.Boolean,
      shout: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    }) as unknown as SettingsSchema;
    expect(fingerprintSettingsSchema(retyped)).not.toBe(fingerprintSettingsSchema(base));
  });

  it("changes when a field is renamed", () => {
    const renamed = Schema.Struct({
      endpoint: Schema.String,
      shout: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    }) as unknown as SettingsSchema;
    expect(fingerprintSettingsSchema(renamed)).not.toBe(fingerprintSettingsSchema(base));
  });

  // Removing a default makes a field required, which genuinely can break stored
  // values that omit it — so this MUST be detected.
  it("changes when a decoding default is removed", () => {
    const undefaulted = Schema.Struct({
      baseUrl: Schema.String,
      shout: Schema.Boolean,
    }) as unknown as SettingsSchema;
    expect(fingerprintSettingsSchema(undefaulted)).not.toBe(fingerprintSettingsSchema(base));
  });

  it("changes when a field is added", () => {
    const extended = Schema.Struct({
      baseUrl: Schema.String,
      shout: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
      extra: Schema.String,
    }) as unknown as SettingsSchema;
    expect(fingerprintSettingsSchema(extended)).not.toBe(fingerprintSettingsSchema(base));
  });

  // Stored values still decode, so there is nothing to repair — flagging this would
  // brick config for a cosmetic change.
  it("is unchanged when only a default's VALUE changes", () => {
    const otherDefault = Schema.Struct({
      baseUrl: Schema.String,
      shout: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
    }) as unknown as SettingsSchema;
    expect(fingerprintSettingsSchema(otherDefault)).toBe(fingerprintSettingsSchema(base));
  });
});
