import { describe, expect, it } from "@effect/vitest";
import { PLUGIN_TOOL_LIMITS, PluginToolDeclaration } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { compileInputSchema, jsonBytes, preparePluginTools } from "./pluginToolDeclarations.ts";

const validator = (inputSchema: Record<string, unknown>) => {
  const compiled = compileInputSchema(inputSchema);
  if ("problem" in compiled) throw new Error(compiled.problem);
  return (input: unknown) => Exit.isSuccess(compiled.validate(input));
};

const problemOf = (inputSchema: Record<string, unknown>) => {
  const compiled = compileInputSchema(inputSchema);
  return "problem" in compiled ? compiled.problem : undefined;
};

const decodeDeclaration = Schema.decodeUnknownSync(PluginToolDeclaration);

describe("compileInputSchema", () => {
  it("rejects extra keys on closed objects at every level and keeps them on open ones", () => {
    const accepts = validator({
      type: "object",
      properties: {
        text: { type: "string" },
        options: {
          type: "object",
          properties: { exact: { type: "boolean" } },
          additionalProperties: false,
        },
        extra: { type: "object", properties: { a: { type: "number" } } },
      },
      required: ["text"],
      additionalProperties: false,
    });
    expect(accepts({ text: "yes" })).toBe(true);
    expect(accepts({ text: "yes", extra: 1 })).toBe(false);
    expect(accepts({ text: "yes", options: { exact: true } })).toBe(true);
    expect(accepts({ text: "yes", options: { exact: true, fuzzy: 1 } })).toBe(false);
    expect(accepts({ text: "yes", extra: { a: 1, anything: [1, "x"] } })).toBe(true);
    expect(accepts({ text: "yes", extra: { a: "1" } })).toBe(false);
    expect(accepts({})).toBe(false);
    expect(accepts({ text: null })).toBe(false);

    const open = validator({ type: "object", properties: { n: { type: "integer" } } });
    expect(open({ n: 1, other: true })).toBe(true);
    expect(open({ n: 1.5 })).toBe(false);
    expect(open([])).toBe(false);
    expect(validator({ type: "object", additionalProperties: false })({ a: 1 })).toBe(false);
  });

  it("counts string lengths in code points, as JSON Schema does", () => {
    const accepts = validator({
      type: "object",
      properties: { x: { type: "string", minLength: 2, maxLength: 2 } },
    });
    expect(accepts({ x: "😀😀" })).toBe(true);
    expect(accepts({ x: "😀" })).toBe(false);
    expect(accepts({ x: "abc" })).toBe(false);
  });

  it("enforces numbers, arrays, enums, unions and type lists with JSON Schema's meaning", () => {
    const accepts = validator({
      type: "object",
      properties: {
        n: { type: "number", exclusiveMinimum: 0, maximum: 10 },
        i: { type: "integer", minimum: -2 },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
        mode: { type: "string", enum: ["a", "b"] },
        flag: { const: true },
        id: { anyOf: [{ type: "string", maxLength: 3 }, { type: "integer" }] },
        note: { type: ["string", "null"], maxLength: 1 },
        any: { description: "Anything." },
      },
    });
    expect(
      accepts({
        n: 10,
        i: 1.0,
        tags: ["x"],
        mode: "b",
        flag: true,
        id: 7,
        note: null,
        any: { deep: [1] },
      }),
    ).toBe(true);
    for (const bad of [
      { n: 0 },
      { n: 10.5 },
      { i: -3 },
      { i: 0.5 },
      { tags: [] },
      { tags: ["a", "b", "c"] },
      { tags: [1] },
      { mode: "c" },
      { flag: false },
      { id: "abcd" },
      { id: 1.5 },
      { note: "ab" },
    ])
      expect(accepts(bad), JSON.stringify(bad)).toBe(false);
  });

  it("resolves root definitions, including recursion through properties", () => {
    const accepts = validator({
      type: "object",
      properties: { tree: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          properties: {
            name: { type: "string" },
            children: { type: "array", items: { $ref: "#/$defs/Node" } },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    });
    expect(accepts({ tree: { name: "a", children: [{ name: "b", children: [] }] } })).toBe(true);
    expect(accepts({ tree: { name: "a", children: [{ children: [] }] } })).toBe(false);
    expect(accepts({ tree: { name: "a", children: [{ name: "b", x: 1 }] } })).toBe(false);
  });

  it("accepts an Effect Schema exported as the module doc shows and enforces it", () => {
    const Range = Schema.Struct({
      from: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      to: Schema.optionalKey(Schema.Int),
    }).annotate({ identifier: "Range" });
    const Input = Schema.Struct({
      text: Schema.String.check(Schema.isMaxLength(100)),
      mode: Schema.Literals(["fast", "exact"]),
      ranges: Schema.Array(Range),
      note: Schema.optionalKey(Schema.NullOr(Schema.String)),
    });
    const { schema, definitions } = Schema.toJsonSchemaDocument(Input, {
      onExcessProperty: "error",
    });
    const inputSchema =
      Object.keys(definitions).length === 0 ? schema : { ...schema, $defs: definitions };
    expect(inputSchema).toHaveProperty("$defs.Range");
    const accepts = validator(inputSchema);
    expect(accepts({ text: "t", mode: "fast", ranges: [{ from: 1 }], note: null })).toBe(true);
    expect(accepts({ text: "t", mode: "fast", ranges: [{ from: -1 }] })).toBe(false);
    expect(accepts({ text: "t", mode: "fast", ranges: [{ from: 1, step: 2 }] })).toBe(false);
    expect(accepts({ text: "t", mode: "slow", ranges: [] })).toBe(false);
  });

  it("names whatever is outside the subset instead of weakening it", () => {
    const object = (properties: Record<string, unknown>) => ({ type: "object", properties });
    const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [object({ id: { type: "string", pattern: "^(a+)+$" } }), "#/properties/id/pattern"],
      [object({ id: { oneOf: [{ type: "string" }] } }), "#/properties/id/oneOf"],
      [object({ id: { allOf: [{ type: "string" }] } }), "#/properties/id/allOf"],
      [object({ n: { type: "number", multipleOf: 2 } }), "#/properties/n/multipleOf"],
      [object({ n: { maxLength: 2 } }), "#/properties/n/maxLength: needs a type"],
      [object({ n: { type: "number", maxLength: 2 } }), "#/properties/n/maxLength: needs a type"],
      [object({ x: { $ref: "#/$defs/X", type: "string" } }), "type cannot be used beside $ref"],
      [object({ x: { $ref: "#/$defs/Missing" } }), "#/properties/x/$ref"],
      [object({ x: { type: "array", items: [{ type: "string" }] } }), "a schema must be an object"],
      [
        object({ x: { type: "object", additionalProperties: { type: "string" } } }),
        "true or false",
      ],
      [object({ x: { enum: [{ a: 1 }] } }), "enum and const take"],
      [object({ x: { type: "string", enum: [1] } }), "does not match its type"],
      [{ ...object({}), required: ["missing"] }, "#/required"],
      [{ type: "string" }, 'the root must be "object"'],
      [{ type: ["object", "null"] }, 'the root must be "object"'],
      [
        {
          ...object({ x: { $ref: "#/$defs/A" } }),
          $defs: { A: { anyOf: [{ $ref: "#/$defs/B" }] }, B: { anyOf: [{ $ref: "#/$defs/A" }] } },
        },
        "reference cycle must pass through properties or items",
      ],
    ];
    for (const [schema, expected] of cases) expect(problemOf(schema)).toContain(expected);

    let deep: Record<string, unknown> = { type: "string" };
    for (let level = 0; level <= PLUGIN_TOOL_LIMITS.maxInputSchemaDepth; level++)
      deep = { type: "array", items: deep };
    expect(problemOf(object({ deep }))).toContain("nest deeper than");
    expect(
      problemOf(object({ big: { type: "string", description: "x".repeat(16 * 1024) } })),
    ).toContain("exceeds 16384 bytes");
  });

  describe("the subset boundary", () => {
    const object = (properties: Record<string, unknown>) => ({ type: "object", properties });
    const property = (schema: unknown) => object({ x: schema });

    it.each<Record<string, unknown>>([
      { type: "object" },
      { type: "object", properties: {}, required: [], additionalProperties: true },
      { type: "object", $defs: {} },
      { type: "object", $defs: { Unused: { type: "string", minLength: 1 } } },
      {
        ...property({ $ref: "#/$defs/Used", description: "Annotations may sit beside $ref." }),
        $defs: { Used: { type: "string" } },
      },
      property({ anyOf: [{ type: "string" }, { type: "null" }], title: "Beside anyOf too." }),
      property({
        type: "string",
        title: "t",
        description: "d",
        $comment: "c",
        format: "uri",
        examples: [],
        deprecated: false,
        readOnly: true,
        writeOnly: false,
        default: null,
      }),
      property({ type: ["string", "null"], maxLength: 0 }),
      property({ enum: [1, "a", true, null] }),
      property({ const: null }),
      property({ type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1.5 }),
      property({ type: "array", minItems: 0 }),
    ])("accepts %j", (schema) => expect(problemOf(schema)).toBeUndefined());

    it.each<readonly [string, Record<string, unknown>, string]>([
      // A default only replaces an absent keyword; null is a wrong shape.
      ["null properties", { type: "object", properties: null }, "#/properties: must be an object"],
      ["null required", { type: "object", required: null }, "#/required"],
      [
        "null additionalProperties",
        { type: "object", additionalProperties: null },
        "#/additionalProperties: must be true or false",
      ],
      ["null $defs", { type: "object", $defs: null }, "#/$defs: must be an object"],
      ["array $defs", { type: "object", $defs: [] }, "#/$defs: must be an object"],
      // Names are own properties, never inherited ones.
      [
        "an inherited required name",
        { ...object({}), required: ["toString"], additionalProperties: false },
        "#/required",
      ],
      ["an inherited definition", property({ $ref: "#/$defs/toString" }), "#/properties/x/$ref"],
      // Every definition is checked, referenced or not.
      [
        "an unused definition outside the subset",
        { type: "object", $defs: { Unused: { type: "string", pattern: "x" } } },
        "#/$defs/Unused/pattern",
      ],
      [
        // A is compiled through the property first; reusing it must not skip the cycle check.
        "an unguarded cycle beside a guarded path to the same definition",
        {
          ...property({ $ref: "#/$defs/A" }),
          $defs: {
            A: {
              anyOf: [
                { type: "object", properties: { child: { $ref: "#/$defs/B" } } },
                { $ref: "#/$defs/B" },
              ],
            },
            B: { $ref: "#/$defs/A" },
          },
        },
        "#/$defs/B/$ref: a reference cycle must pass through properties or items",
      ],
      [
        "an unused definition with an unguarded cycle",
        { type: "object", $defs: { A: { anyOf: [{ $ref: "#/$defs/A" }] } } },
        "reference cycle",
      ],
      ["a bad definition name", { type: "object", $defs: { "a b": {} } }, "#/$defs/a b"],
      ["nested $defs", property({ $defs: {} }), "only supported at the root"],
      ["a draft-7 ref", property({ $ref: "#/definitions/X" }), "#/properties/x/$ref"],
      // Annotations are shown, so they must have their shape.
      ["a numeric title", property({ type: "string", title: 1 }), "#/properties/x/title"],
      ["a null description", property({ description: null }), "#/properties/x/description"],
      ["object examples", property({ examples: {} }), "#/properties/x/examples"],
      ["a string deprecated", property({ deprecated: "yes" }), "#/properties/x/deprecated"],
      ["a null readOnly", property({ readOnly: null }), "#/properties/x/readOnly"],
      ["a numeric writeOnly", property({ writeOnly: 0 }), "#/properties/x/writeOnly"],
      ["a numeric format", property({ type: "string", format: 1 }), "#/properties/x/format"],
      ["an array $comment", property({ $comment: [] }), "#/properties/x/$comment"],
      // Supported keywords with the wrong shape.
      ["an empty type list", property({ type: [] }), "#/properties/x/type"],
      ["a repeated type", property({ type: ["string", "string"] }), "#/properties/x/type"],
      ["an unknown type", property({ type: "date" }), "#/properties/x/type"],
      ["a null type", property({ type: null }), "#/properties/x/type"],
      ["a negative minLength", property({ type: "string", minLength: -1 }), "minLength"],
      ["a fractional minLength", property({ type: "string", minLength: 1.5 }), "minLength"],
      ["a null maxLength", property({ type: "string", maxLength: null }), "maxLength"],
      ["a string maxItems", property({ type: "array", maxItems: "2" }), "maxItems"],
      ["a null minimum", property({ type: "number", minimum: null }), "minimum"],
      [
        "a draft-4 exclusiveMinimum",
        property({ type: "number", exclusiveMinimum: true }),
        "exclusiveMinimum",
      ],
      ["null items", property({ type: "array", items: null }), "#/properties/x/items"],
      ["boolean items", property({ type: "array", items: true }), "#/properties/x/items"],
      ["a boolean schema", object({ x: true }), "#/properties/x: a schema must be an object"],
      ["a null schema", object({ x: null }), "#/properties/x: a schema must be an object"],
      ["an empty anyOf", property({ anyOf: [] }), "#/properties/x/anyOf"],
      ["an object anyOf", property({ anyOf: {} }), "#/properties/x/anyOf"],
      ["an empty enum", property({ enum: [] }), "enum and const take"],
      ["a null enum", property({ enum: null }), "enum and const take"],
      ["an object const", property({ const: {} }), "enum and const take"],
      ["enum and const", property({ enum: [1], const: 1 }), "use enum or const"],
      // Keywords outside the subset, named.
      ...[
        "$schema",
        "$id",
        "$anchor",
        "$dynamicRef",
        "definitions",
        "patternProperties",
        "propertyNames",
        "minProperties",
        "maxProperties",
        "dependentRequired",
        "dependentSchemas",
        "unevaluatedProperties",
        "unevaluatedItems",
        "prefixItems",
        "contains",
        "uniqueItems",
        "if",
        "not",
        "nullable",
        "contentMediaType",
      ].map(
        (keyword) =>
          [
            keyword,
            property({ type: "object", [keyword]: {} }),
            `#/properties/x/${keyword}: this keyword is not supported`,
          ] as const,
      ),
    ])("refuses %s", (_, schema, expected) => expect(problemOf(schema)).toContain(expected));
  });

  it("shows defaults and formats without applying or asserting them", () => {
    const accepts = validator({
      type: "object",
      properties: { url: { type: "string", format: "uri", default: "https://example.com" } },
      additionalProperties: false,
    });
    expect(accepts({})).toBe(true);
    expect(accepts({ url: "not a uri" })).toBe(true);
  });
});

describe("preparePluginTools", () => {
  const plugin = { id: "test.prepare", name: "Prepare" };
  const tool = (name: string, description: string) =>
    decodeDeclaration({ name, description, inputSchema: { type: "object" }, sideEffect: "read" });

  it("lists the declared schema unchanged and counts exact UTF-8 listing bytes", () => {
    const declared = decodeDeclaration({
      name: "lookup",
      title: "Look up",
      description: "Look up a word, déjà vu.",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      sideEffect: "read",
      openWorld: true,
      timeoutSeconds: 5,
    });
    const prepared = preparePluginTools(plugin, [declared]);
    if ("problem" in prepared) throw new Error(prepared.problem);
    const listing = prepared.tools.get("lookup")!.listing;
    expect(listing).toEqual({
      tool: "test.prepare/lookup",
      plugin,
      title: "Look up",
      description: "Look up a word, déjà vu.",
      inputSchema: declared.inputSchema,
      sideEffect: "read",
      openWorld: true,
    });
    expect(prepared.tools.get("lookup")!.timeoutSeconds).toBe(5);
    expect(prepared.listingBytes).toBe(jsonBytes(listing) + 1);
  });

  it("refuses duplicate names and a listing past its byte limit, multibyte included", () => {
    expect(preparePluginTools(plugin, [tool("a", "One."), tool("a", "Two.")])).toEqual({
      problem: "it declares the tool a twice.",
    });
    // 32 tools of 1,000 three-byte characters: under 48 KiB in characters, over it in bytes.
    const wide = Array.from({ length: 32 }, (_, index) => tool(`t_${index}`, "€".repeat(1000)));
    expect(preparePluginTools(plugin, wide)).toEqual({
      problem: `its tools take more than ${PLUGIN_TOOL_LIMITS.maxPluginListingBytes} bytes to list.`,
    });
  });
});
