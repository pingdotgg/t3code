import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  findPluginSettingsSchemaViolations,
  fingerprintSettingsSchema,
  stripAgainstJsonSchemaDocument,
  stripUndeclaredSettings,
  type SettingsSchema,
} from "./pluginSettings.ts";
import {
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  GrokSettings,
  OpenCodeSettings,
} from "@t3tools/contracts";

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

describe("password control", () => {
  // `password` masks the input; it does not store securely. Plugin settings are
  // ordinary plaintext in plugin_settings, readable by anyone with plugins:manage,
  // so a plugin reaching for it to hold an API key would be silently wrong. Secrets
  // are out of scope for this slice — SecretsCapability already exists for them.
  it("rejects a password control for plugins", () => {
    const schema = Schema.Struct({
      token: Schema.String.pipe(
        Schema.annotateKey({ providerSettingsForm: { control: "password" } }),
      ),
    }) as unknown as SettingsSchema;
    const violations = findPluginSettingsSchemaViolations(schema, {
      allowPasswordControl: false,
    });
    expect(violations.map((v) => v.field)).toEqual(["token"]);
    expect(violations[0]?.reason).toMatch(/SecretsCapability/);
  });

  // First-party provider schemas predate this and say what they store: OpenCode's
  // serverPassword description literally reads "Stored in plain text on disk."
  it("permits a password control when explicitly allowed", () => {
    const schema = Schema.Struct({
      token: Schema.String.pipe(
        Schema.annotateKey({ providerSettingsForm: { control: "password" } }),
      ),
    }) as unknown as SettingsSchema;
    expect(findPluginSettingsSchemaViolations(schema, { allowPasswordControl: true })).toEqual([]);
  });
});

describe("fingerprint distinguishes constraints", () => {
  // Reducing a field to its primitive JSON `type` erased enums entirely, so these
  // three accept different values yet fingerprinted identically — a schema change
  // between them went undetected, which is the opposite of the bug the fingerprint
  // exists to catch.
  const str = Schema.Struct({ a: Schema.String }) as unknown as SettingsSchema;
  const litAB = Schema.Struct({ a: Schema.Literals(["a", "b"]) }) as unknown as SettingsSchema;
  const litAC = Schema.Struct({ a: Schema.Literals(["a", "c"]) }) as unknown as SettingsSchema;

  it("distinguishes a bare String from a Literals union", () => {
    expect(fingerprintSettingsSchema(litAB)).not.toBe(fingerprintSettingsSchema(str));
  });

  it("distinguishes two Literals unions with different members", () => {
    expect(fingerprintSettingsSchema(litAC)).not.toBe(fingerprintSettingsSchema(litAB));
  });

  it("is stable for the same Literals union", () => {
    const again = Schema.Struct({ a: Schema.Literals(["a", "b"]) }) as unknown as SettingsSchema;
    expect(fingerprintSettingsSchema(again)).toBe(fingerprintSettingsSchema(litAB));
  });
});

describe("stripUndeclaredSettings", () => {
  // Every case below is a shape a reviewer named as a fail-open bypass in the
  // previous version, which returned the value UNCHANGED for anything outside its
  // vocabulary. The rule now: prove the strip, or refuse the write.

  it("drops an undeclared key at the root", () => {
    const result = stripUndeclaredSettings(
      { baseUrl: "https://example.com", injected: "no" },
      Schema.Struct({ baseUrl: Schema.String }),
    );
    expect(result).toEqual({ _tag: "Stripped", value: { baseUrl: "https://example.com" } });
  });

  it("drops an undeclared key nested inside a defaulted field", () => {
    // A decoding default derives to `anyOf: [{...}, {type:"null"}]`, so the object
    // shape is a union MEMBER — reading `properties` off the wrapper finds nothing.
    const schema = Schema.Struct({
      advanced: Schema.Struct({ retries: Schema.String }).pipe(
        Schema.withDecodingDefault(Effect.succeed({ retries: "0" })),
      ),
    });
    const result = stripUndeclaredSettings({ advanced: { retries: "3", injected: "no" } }, schema);
    expect(result).toEqual({ _tag: "Stripped", value: { advanced: { retries: "3" } } });
  });

  it("strips inside every element of an array", () => {
    const schema = Schema.Struct({ list: Schema.Array(Schema.Struct({ retries: Schema.String })) });
    const result = stripUndeclaredSettings(
      { list: [{ retries: "1", injected: "no" }, { retries: "2" }] },
      schema,
    );
    expect(result).toEqual({
      _tag: "Stripped",
      value: { list: [{ retries: "1" }, { retries: "2" }] },
    });
  });

  it("strips each tuple position against its own schema", () => {
    // A tuple derives to `prefixItems`, NOT an `items` array — the old code saw no
    // `items`, fell through, and returned the tuple unfiltered.
    const schema = Schema.Struct({
      pair: Schema.Tuple([Schema.String, Schema.Struct({ retries: Schema.String })]),
    });
    const result = stripUndeclaredSettings(
      { pair: ["a", { retries: "1", injected: "no" }] },
      schema,
    );
    expect(result).toEqual({ _tag: "Stripped", value: { pair: ["a", { retries: "1" }] } });
  });

  it("keeps open Record keys but strips their values", () => {
    // `additionalProperties` as a SCHEMA means the keys are legitimately open, so
    // dropping them would delete the user's data. The VALUES are still stripped.
    const schema = Schema.Struct({
      map: Schema.Record(Schema.String, Schema.Struct({ retries: Schema.String })),
    });
    const result = stripUndeclaredSettings(
      { map: { anyKey: { retries: "1", injected: "no" } } },
      schema,
    );
    expect(result).toEqual({
      _tag: "Stripped",
      value: { map: { anyKey: { retries: "1" } } },
    });
  });

  it("refuses a union with more than one object branch rather than guessing", () => {
    // Guessing has two failure modes and the old code silently took the first
    // branch: strip against the wrong arm DELETES legitimate keys; strip against a
    // permissive arm KEEPS undeclared ones.
    const schema = Schema.Struct({
      u: Schema.Union([
        Schema.Struct({ retries: Schema.String }),
        Schema.Struct({ other: Schema.String }),
      ]),
    });
    const result = stripUndeclaredSettings({ u: { other: "x" } }, schema);
    expect(result._tag).toBe("Unsupported");
  });

  // The test a reviewer asked for, against REAL derivation rather than a hand-built
  // node — which is exactly why the first version of this fix was wrong.
  it("still strips a nested field that carries an annotation", () => {
    // `annotateKey` derives to `{type:"object", properties:{...}, allOf:[{description}]}`
    // — an `allOf` on a node that also has its own properties. Refusing every `allOf`
    // made this ordinary field decode, activate, and then reject every save forever.
    const schema = Schema.Struct({
      advanced: Schema.Struct({ retries: Schema.String }).pipe(
        Schema.annotateKey({ description: "Advanced options" }),
      ),
    });
    const result = stripUndeclaredSettings({ advanced: { retries: "3", injected: "no" } }, schema);
    expect(result).toEqual({ _tag: "Stripped", value: { advanced: { retries: "3" } } });
  });

  it("refuses a genuine structural allOf rather than passing the value through", () => {
    // The node carries its OWN properties as well as a structural allOf member.
    // That combination matters: with an allOf-only node, merely ignoring the allOf
    // would ALSO yield Unsupported (via "declares no properties"), so the test would
    // pass for the wrong reason and could not tell "refused the intersection" from
    // "ignored it". Here, ignoring the allOf would return Stripped and the test fails.
    const result = stripAgainstJsonSchemaDocument({
      value: { retries: "1", extra: "x" },
      schema: {
        type: "object",
        properties: { retries: { type: "string" } },
        allOf: [{ type: "object", properties: { extra: { type: "string" } } }],
      },
    });
    expect(result._tag).toBe("Unsupported");
  });

  it("resolves a $ref emitted by a real identified schema", () => {
    // Derived, NOT hand-written. Effect emits `$ref: "#/$defs/Inner"` while keying the
    // document map `definitions` — a resolver accepting only `#/definitions/` let this
    // schema decode and activate, then rejected every save. Hand-writing the ref form
    // is what hid it: the test asserted a shape Effect never emits.
    const inner = Schema.Struct({ retries: Schema.String }).annotate({ identifier: "Inner" });
    const schema = Schema.Struct({ one: inner, two: inner });
    const result = stripUndeclaredSettings(
      { one: { retries: "1", injected: "no" }, two: { retries: "2" } },
      schema,
    );
    expect(result).toEqual({
      _tag: "Stripped",
      value: { one: { retries: "1" }, two: { retries: "2" } },
    });
  });

  it("refuses patternProperties rather than dropping or leaking keys", () => {
    const result = stripAgainstJsonSchemaDocument({
      value: { declared: "a", "x-1": "b" },
      schema: {
        type: "object",
        properties: { declared: { type: "string" } },
        patternProperties: { "^x-": { type: "string" } },
      },
    });
    expect(result._tag).toBe("Unsupported");
  });

  it("refuses a recursive $ref rather than looping or passing through", () => {
    const result = stripAgainstJsonSchemaDocument({
      value: { self: { self: {} } },
      schema: { $ref: "#/definitions/Node" },
      definitions: {
        Node: { type: "object", properties: { self: { $ref: "#/definitions/Node" } } },
      },
    });
    expect(result._tag).toBe("Unsupported");
  });

  it("refuses an object whose additionalProperties is `true`", () => {
    // `true` permits any key. Keeping them reopens the leak; dropping them silently
    // deletes data the schema allows. Refusing is the only defensible answer.
    const result = stripAgainstJsonSchemaDocument({
      value: { declared: "a", extra: "b" },
      schema: {
        type: "object",
        properties: { declared: { type: "string" } },
        additionalProperties: true,
      },
    });
    expect(result._tag).toBe("Unsupported");
  });

  it("refuses an object schema that declares no properties", () => {
    // A bare {"type":"object"} declares nothing, so every key is undeclared and
    // keeping them all is the exact leak this function exists to stop.
    const result = stripAgainstJsonSchemaDocument({
      value: { anything: "goes" },
      schema: { type: "object" },
    });
    expect(result._tag).toBe("Unsupported");
  });

  it("names the path of the offending node so the failure is actionable", () => {
    const result = stripAgainstJsonSchemaDocument({
      value: { outer: { inner: { x: 1 } } },
      schema: {
        type: "object",
        properties: { outer: { type: "object", properties: { inner: { type: "object" } } } },
      },
    });
    expect(result._tag).toBe("Unsupported");
    expect(result._tag === "Unsupported" ? result.path : "").toBe("outer.inner");
  });

  it("passes primitives through: they cannot carry an undeclared key", () => {
    // This is what keeps fail-closed from rejecting ordinary schemas — only objects
    // and arrays ever reach a shape check.
    const result = stripUndeclaredSettings({ n: 1 }, Schema.Struct({ n: Schema.Number }));
    expect(result).toEqual({ _tag: "Stripped", value: { n: 1 } });
  });
});
