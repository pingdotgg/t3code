import { assert, describe, it } from "@effect/vitest"
import { Schema, SchemaAST, SchemaRepresentation } from "effect"

describe("SchemaRepresentation.toRepresentation", () => {
  it("converts Null", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.Null.ast), {
      representation: { _tag: "Null", checks: [] },
      references: {}
    })
  })

  it("converts Undefined", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.Undefined.ast), {
      representation: { _tag: "Undefined", checks: [] },
      references: {}
    })
  })

  it("converts Void", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.Void.ast), {
      representation: { _tag: "Void", checks: [] },
      references: {}
    })
  })

  it("converts Never", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.Never.ast), {
      representation: { _tag: "Never", checks: [] },
      references: {}
    })
  })

  it("converts Unknown", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.Unknown.ast), {
      representation: { _tag: "Unknown", checks: [] },
      references: {}
    })
  })

  it("converts Any", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.Any.ast), {
      representation: { _tag: "Any", checks: [] },
      references: {}
    })
  })

  it("converts String", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.String.ast), {
      representation: { _tag: "String", checks: [] },
      references: {}
    })
  })

  it("converts Number", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.Number.ast), {
      representation: { _tag: "Number", checks: [] },
      references: {}
    })
  })

  it("converts Boolean", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.Boolean.ast), {
      representation: { _tag: "Boolean", checks: [] },
      references: {}
    })
  })

  it("converts BigInt", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.BigInt.ast), {
      representation: { _tag: "BigInt", checks: [] },
      references: {}
    })
  })

  it("converts Symbol", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.Symbol.ast), {
      representation: { _tag: "Symbol", checks: [] },
      references: {}
    })
  })

  it("converts ObjectKeyword", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.ObjectKeyword.ast), {
      representation: { _tag: "ObjectKeyword", checks: [] },
      references: {}
    })
  })

  it("converts a literal", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.Literal("value").ast), {
      representation: { _tag: "Literal", literal: "value", checks: [] },
      references: {}
    })
  })

  it("converts a global unique symbol", () => {
    const symbol = Symbol.for("value")
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.UniqueSymbol(symbol).ast), {
      representation: { _tag: "UniqueSymbol", symbol, checks: [] },
      references: {}
    })
  })

  it("converts an enum", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.Enum({ A: "a", One: 1 }).ast), {
      representation: {
        _tag: "Enum",
        enums: [
          ["A", "a"],
          ["One", 1]
        ],
        checks: []
      },
      references: {}
    })
  })

  it("converts a template literal", () => {
    assert.deepStrictEqual(
      SchemaRepresentation.toRepresentation(Schema.TemplateLiteral(["prefix-", Schema.String, Schema.Number]).ast),
      {
        representation: {
          _tag: "TemplateLiteral",
          parts: [
            { _tag: "Literal", literal: "prefix-", checks: [] },
            { _tag: "String", checks: [] },
            { _tag: "Number", checks: [] }
          ],
          checks: []
        },
        references: {}
      }
    )
  })

  it("converts tuple elements and rest", () => {
    const schema = Schema.TupleWithRest(
      Schema.Tuple([Schema.String, Schema.optionalKey(Schema.Number)]),
      [Schema.Boolean]
    )

    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(schema.ast), {
      representation: {
        _tag: "Arrays",
        elements: [
          { type: { _tag: "String", checks: [] }, isOptional: false },
          { type: { _tag: "Number", checks: [] }, isOptional: true }
        ],
        rest: [{ _tag: "Boolean", checks: [] }],
        checks: []
      },
      references: {}
    })
  })

  it("converts object properties and index signatures", () => {
    const schema = Schema.StructWithRest(
      Schema.Struct({
        required: Schema.String,
        optional: Schema.optionalKey(Schema.Number),
        mutable: Schema.mutableKey(Schema.Boolean)
      }),
      [Schema.Record(Schema.Symbol, Schema.BigInt)]
    )

    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(schema.ast), {
      representation: {
        _tag: "Objects",
        propertySignatures: [
          {
            name: "required",
            type: { _tag: "String", checks: [] },
            isOptional: false,
            isMutable: false
          },
          {
            name: "optional",
            type: { _tag: "Number", checks: [] },
            isOptional: true,
            isMutable: false
          },
          {
            name: "mutable",
            type: { _tag: "Boolean", checks: [] },
            isOptional: false,
            isMutable: true
          }
        ],
        indexSignatures: [{
          parameter: { _tag: "Symbol", checks: [] },
          type: { _tag: "BigInt", checks: [] }
        }],
        checks: []
      },
      references: {}
    })
  })

  it("converts a union preserving member order", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.Union([Schema.String, Schema.BigInt]).ast), {
      representation: {
        _tag: "Union",
        types: [
          { _tag: "String", checks: [] },
          { _tag: "BigInt", checks: [] }
        ],
        mode: "anyOf",
        checks: []
      },
      references: {}
    })
  })

  it("uses the encoded side of a transformation", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.NumberFromString.ast), {
      representation: {
        _tag: "String",
        annotations: { expected: "a string that will be decoded as a number" },
        checks: []
      },
      references: {}
    })
  })

  it("uses the type side when the caller projects it", () => {
    assert.deepStrictEqual(
      SchemaRepresentation.toRepresentation(SchemaAST.toType(Schema.NumberFromString.ast)),
      {
        representation: { _tag: "Number", checks: [] },
        references: {}
      }
    )
  })

  it("preserves brands", () => {
    assert.deepStrictEqual(
      SchemaRepresentation.toRepresentation(Schema.String.pipe(Schema.brand("A"), Schema.brand("B")).ast),
      {
        representation: {
          _tag: "String",
          annotations: { brands: ["A", "B"] },
          checks: []
        },
        references: {}
      }
    )
  })

  it("preserves declaration code callbacks", () => {
    const toCode: SchemaRepresentation.Generation.Declaration = () => ({ runtime: "Custom", Type: "string" })
    const schema = Schema.declare<string>((input): input is string => typeof input === "string", {
      representation: {
        id: "acme/schema/Custom",
        payload: null
      },
      toCode
    })

    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(schema.ast), {
      representation: {
        _tag: "Declaration",
        typeParameters: [],
        checks: [],
        representation: {
          id: "acme/schema/Custom",
          payload: null
        },
        annotations: {
          toCode
        }
      },
      references: {}
    })
  })

  it("converts declaration type parameters", () => {
    const representation = SchemaRepresentation.toRepresentation(Schema.Option(Schema.Number).ast).representation

    assert.strictEqual(representation._tag, "Declaration")
    if (representation._tag !== "Declaration") return
    assert.deepStrictEqual(representation.typeParameters, [{ _tag: "Number", checks: [] }])
  })

  it("preserves custom filter callbacks, dependencies and aborted state", () => {
    const toCode: SchemaRepresentation.Generation.Check = () => ({ runtime: "Custom" })
    const toJsonSchema: SchemaRepresentation.ToJsonSchema.Check = () => ({ minLength: 1 })
    const marker = () => "marker"
    const filter = Schema.makeFilter<string>(() => true, {
      representation: {
        id: "acme/schema/Custom",
        payload: { minimum: 1 },
        schemas: [Schema.Number.ast]
      },
      toCode,
      toJsonSchema,
      marker
    }).abort()

    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.String.check(filter).ast), {
      representation: {
        _tag: "String",
        checks: [{
          _tag: "Filter",
          representation: {
            id: "acme/schema/Custom",
            payload: { minimum: 1 },
            schemas: [{ _tag: "Number", checks: [] }]
          },
          annotations: {
            toCode,
            toJsonSchema,
            marker
          },
          aborted: true
        }]
      },
      references: {}
    })
  })

  it("preserves filters without persistence metadata", () => {
    const filter = Schema.makeFilter<string>(() => true, { expected: "custom" })

    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.String.check(filter).ast), {
      representation: {
        _tag: "String",
        checks: [{
          _tag: "Filter",
          annotations: { expected: "custom" },
          aborted: false
        }]
      },
      references: {}
    })
  })

  it("preserves a filter without annotations", () => {
    const filter = Schema.makeFilter<string>(() => true)

    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.String.check(filter).ast), {
      representation: {
        _tag: "String",
        checks: [{ _tag: "Filter", aborted: false }]
      },
      references: {}
    })
  })

  it("preserves filter groups", () => {
    const first = Schema.makeFilter<string>(() => true, { expected: "first" })
    const second = Schema.makeFilter<string>(() => true, { expected: "second" })
    const group = Schema.makeFilterGroup([first, second], { description: "group" })

    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.String.check(group).ast), {
      representation: {
        _tag: "String",
        checks: [{
          _tag: "FilterGroup",
          annotations: { description: "group" },
          checks: [
            { _tag: "Filter", annotations: { expected: "first" }, aborted: false },
            { _tag: "Filter", annotations: { expected: "second" }, aborted: false }
          ]
        }]
      },
      references: {}
    })
  })

  it("converts representation dependencies of built-in filters", () => {
    const schema = Schema.Record(Schema.String, Schema.Number).check(
      Schema.isPropertyNames(Schema.String.check(Schema.isPattern(/^[A-Z]/)))
    )
    const representation = SchemaRepresentation.toRepresentation(schema.ast).representation

    assert.strictEqual(representation._tag, "Objects")
    if (representation._tag !== "Objects") return
    const check = representation.checks[0]
    assert.strictEqual(check._tag, "Filter")
    if (check._tag !== "Filter") return
    const dependency = check.representation?.schemas?.[0]
    assert.isDefined(dependency)
    assert.deepStrictEqual(
      SchemaRepresentation.toJson({ representation: dependency, references: {} }),
      {
        representation: {
          _tag: "String",
          checks: [{
            _tag: "Filter",
            representation: {
              id: "effect/schema/isPattern",
              payload: { source: "^[A-Z]", flags: "" }
            },
            annotations: {
              arbitrary: { constraint: { patterns: ["^[A-Z]"] } },
              expected: "a string matching the RegExp ^[A-Z]"
            },
            aborted: false
          }]
        },
        references: {}
      }
    )
  })

  it("extracts shared representation dependencies of filters", () => {
    const shared = Schema.Struct({ value: Schema.String })
    const filter = Schema.makeFilter<string>(() => true, {
      representation: {
        id: "acme/schema/Custom",
        payload: null,
        schemas: [shared.ast, shared.ast]
      }
    })
    const document = SchemaRepresentation.toRepresentation(Schema.String.check(filter).ast)
    const representation = document.representation

    assert.strictEqual(representation._tag, "String")
    if (representation._tag !== "String") return
    assert.deepStrictEqual(representation.checks[0].representation?.schemas, [
      { _tag: "Reference", $ref: "Objects_" },
      { _tag: "Reference", $ref: "Objects_" }
    ])
    assert.deepStrictEqual(Object.keys(document.references), ["Objects_"])
  })

  it("converts checks on arrays", () => {
    const representation = SchemaRepresentation.toRepresentation(
      Schema.Array(Schema.String).check(Schema.isMinLength(1)).ast
    ).representation

    assert.strictEqual(representation._tag, "Arrays")
    if (representation._tag !== "Arrays") return
    assert.strictEqual(representation.checks.length, 1)
    assert.deepStrictEqual(representation.checks[0].representation, {
      id: "effect/schema/isMinLength",
      payload: { minLength: 1 }
    })
  })

  it("converts checks on objects", () => {
    const representation = SchemaRepresentation.toRepresentation(
      Schema.Record(Schema.String, Schema.Number).check(Schema.isMinProperties(1)).ast
    ).representation

    assert.strictEqual(representation._tag, "Objects")
    if (representation._tag !== "Objects") return
    assert.strictEqual(representation.checks.length, 1)
    assert.deepStrictEqual(representation.checks[0].representation, {
      id: "effect/schema/isMinProperties",
      payload: { minProperties: 1 }
    })
  })

  it("preserves fromJsonString annotations", () => {
    const schema = SchemaAST.toEncoded(Schema.fromJsonString(Schema.Struct({ value: Schema.Number })).ast)
    const document = SchemaRepresentation.toRepresentation(schema)

    assert.deepStrictEqual(document, {
      representation: {
        _tag: "String",
        annotations: {
          contentMediaType: "application/json",
          expected: "a string that will be decoded as JSON"
        },
        checks: []
      },
      references: {}
    })
  })

  it("preserves tuple element annotations", () => {
    const marker = () => "element"
    const schema = Schema.Tuple([Schema.String.annotateKey({ description: "element", marker })])

    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(schema.ast), {
      representation: {
        _tag: "Arrays",
        elements: [{
          type: { _tag: "String", checks: [] },
          isOptional: false,
          annotations: { description: "element", marker }
        }],
        rest: [],
        checks: []
      },
      references: {}
    })
  })

  it("preserves property annotations", () => {
    const marker = () => "property"
    const schema = Schema.Struct({
      value: Schema.String.annotateKey({ description: "property", marker })
    })

    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(schema.ast), {
      representation: {
        _tag: "Objects",
        propertySignatures: [{
          name: "value",
          type: { _tag: "String", checks: [] },
          isOptional: false,
          isMutable: false,
          annotations: { description: "property", marker }
        }],
        indexSignatures: [],
        checks: []
      },
      references: {}
    })
  })

  it("extracts shared Objects, Arrays, and Union schemas into references", () => {
    const object = Schema.Struct({ value: Schema.String })
    const array = Schema.Array(Schema.Number)
    const union = Schema.Union([Schema.Struct({ value: Schema.String }), Schema.Null])
    const document = SchemaRepresentation.toRepresentation(
      Schema.Tuple([object, object, array, array, union, union]).ast
    )

    assert.deepStrictEqual(document, {
      representation: {
        _tag: "Arrays",
        elements: [
          { type: { _tag: "Reference", $ref: "Objects_" }, isOptional: false },
          { type: { _tag: "Reference", $ref: "Objects_" }, isOptional: false },
          { type: { _tag: "Reference", $ref: "Arrays_" }, isOptional: false },
          { type: { _tag: "Reference", $ref: "Arrays_" }, isOptional: false },
          { type: { _tag: "Reference", $ref: "Union_" }, isOptional: false },
          { type: { _tag: "Reference", $ref: "Union_" }, isOptional: false }
        ],
        rest: [],
        checks: []
      },
      references: {
        Objects_: {
          _tag: "Objects",
          propertySignatures: [{
            name: "value",
            type: { _tag: "String", checks: [] },
            isOptional: false,
            isMutable: false
          }],
          indexSignatures: [],
          checks: []
        },
        Arrays_: {
          _tag: "Arrays",
          elements: [],
          rest: [{ _tag: "Number", checks: [] }],
          checks: []
        },
        Union_: {
          _tag: "Union",
          types: [
            {
              _tag: "Objects",
              propertySignatures: [{
                name: "value",
                type: { _tag: "String", checks: [] },
                isOptional: false,
                isMutable: false
              }],
              indexSignatures: [],
              checks: []
            },
            { _tag: "Null", checks: [] }
          ],
          mode: "anyOf",
          checks: []
        }
      }
    })
  })

  it("does not extract shared unions of leaf schemas", () => {
    const union = Schema.Union([Schema.String, Schema.Number])
    const document = SchemaRepresentation.toRepresentation(Schema.Tuple([union, union]).ast)

    assert.deepStrictEqual(document.references, {})
    assert.strictEqual(document.representation._tag, "Arrays")
    if (document.representation._tag === "Arrays") {
      assert.deepStrictEqual(document.representation.elements.map((element) => element.type._tag), ["Union", "Union"])
    }
  })

  it("does not extract structurally equivalent schemas with distinct ASTs", () => {
    const first = Schema.Struct({ value: Schema.String })
    const second = Schema.Struct({ value: Schema.String })
    const document = SchemaRepresentation.toRepresentation(Schema.Tuple([first, second]).ast)

    assert.deepStrictEqual(document.references, {})
  })

  it("does not extract a child solely because its shared parent is reused", () => {
    const child = Schema.Struct({ value: Schema.String })
    const parent = Schema.Struct({ child })
    const document = SchemaRepresentation.toRepresentation(Schema.Tuple([parent, parent]).ast)

    assert.deepStrictEqual(Object.keys(document.references), ["Objects_"])
  })

  it("does not extract shared trivial or Suspend schemas", () => {
    const suspend = Schema.suspend(() => Schema.String)
    const document = SchemaRepresentation.toRepresentation(
      Schema.Tuple([Schema.String, Schema.String, suspend, suspend]).ast
    )

    assert.deepStrictEqual(document.references, {})
  })

  it("extracts a named schema into references", () => {
    const schema = Schema.String.annotate({ identifier: "Value", description: "value" })

    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(schema.ast), {
      representation: { _tag: "Reference", $ref: "Value" },
      references: {
        Value: {
          _tag: "String",
          annotations: { identifier: "Value", description: "value" },
          checks: []
        }
      }
    })
  })

  it("supports __proto__ as an identifier", () => {
    const document = SchemaRepresentation.toRepresentation(
      Schema.String.annotate({ identifier: "__proto__" }).ast
    )

    assert.deepStrictEqual(document.representation, { _tag: "Reference", $ref: "__proto__" })
    assert.deepStrictEqual(Object.keys(document.references), ["__proto__"])
    assert.strictEqual(Object.getPrototypeOf(document.references), Object.prototype)
    assert.isTrue(Object.hasOwn(document.references, "__proto__"))
    assert.strictEqual(document.references["__proto__"]._tag, "String")
  })

  it("converts a non-recursive suspend", () => {
    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Schema.suspend(() => Schema.String).ast), {
      representation: {
        _tag: "Suspend",
        thunk: { _tag: "String", checks: [] },
        checks: []
      },
      references: {}
    })
  })

  it("uses an outer identifier for a recursive schema", () => {
    interface Node {
      readonly next?: Node
    }
    const Node = Schema.Struct({
      next: Schema.optionalKey(Schema.suspend((): Schema.Codec<Node> => Node))
    }).annotate({ identifier: "Node" })

    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(Node.ast), {
      representation: { _tag: "Reference", $ref: "Node" },
      references: {
        Node: {
          _tag: "Objects",
          annotations: { identifier: "Node" },
          propertySignatures: [{
            name: "next",
            type: {
              _tag: "Suspend",
              thunk: { _tag: "Reference", $ref: "Node" },
              checks: []
            },
            isOptional: true,
            isMutable: false
          }],
          indexSignatures: [],
          checks: []
        }
      }
    })
  })

  it("rejects recursive schemas with duplicate identifiers", () => {
    interface First {
      readonly next?: First
    }
    const First = Schema.Struct({
      next: Schema.optionalKey(Schema.suspend((): Schema.Codec<First> => First))
    }).annotate({ identifier: "Node" })
    interface Second {
      readonly next?: Second
    }
    const Second = Schema.Struct({
      next: Schema.optionalKey(Schema.suspend((): Schema.Codec<Second> => Second))
    }).annotate({ identifier: "Node" })

    assert.throws(
      () => SchemaRepresentation.toRepresentation(Schema.Tuple([First, Second]).ast),
      /Duplicate identifier: "Node"/
    )
  })

  it("does not resolve an identifier below a check", () => {
    const schema = Schema.String
      .annotate({ identifier: "Text" })
      .pipe(Schema.check(Schema.isMinLength(1)))
    const document = SchemaRepresentation.toRepresentation(schema.ast)

    assert.strictEqual(document.representation._tag, "String")
    assert.deepStrictEqual(document.references, {})
    if (document.representation._tag === "String") {
      assert.deepStrictEqual(document.representation.annotations, { identifier: "Text" })
      assert.strictEqual(document.representation.checks.length, 1)
      assert.strictEqual(document.representation.checks[0].representation?.id, "effect/schema/isMinLength")
    }
  })

  it("uses a fallback identifier for encoded representations", () => {
    const schema = Schema.String.annotate({ "~identifier": "Person" })

    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(schema.ast), {
      representation: { _tag: "Reference", $ref: "PersonJsonEncoding" },
      references: {
        PersonJsonEncoding: {
          _tag: "String",
          checks: [],
          annotations: { "~identifier": "Person" }
        }
      }
    })
  })

  it("prefers an identifier over a fallback identifier", () => {
    const schema = Schema.String.annotate({ identifier: "EncodedPerson", "~identifier": "Person" })
    const document = SchemaRepresentation.toRepresentation(schema.ast)

    assert.deepStrictEqual(document.representation, { _tag: "Reference", $ref: "EncodedPerson" })
    assert.deepStrictEqual(Object.keys(document.references), ["EncodedPerson"])
  })

  it("reuses the class reference", () => {
    class User extends Schema.Class<User>("User")({ name: Schema.String }) {}

    const document = SchemaRepresentation.toRepresentation(SchemaAST.toType(Schema.Tuple([User, User]).ast))
    assert.deepStrictEqual(document.representation, {
      _tag: "Arrays",
      elements: [
        { type: { _tag: "Reference", $ref: "User" }, isOptional: false },
        { type: { _tag: "Reference", $ref: "User" }, isOptional: false }
      ],
      rest: [],
      checks: []
    })
    assert.deepStrictEqual(Object.keys(document.references), ["User"])
  })

  it("extracts anonymous recursion into references", () => {
    let schema: Schema.Codec<unknown>
    schema = Schema.suspend((): Schema.Codec<unknown> => schema)

    assert.deepStrictEqual(SchemaRepresentation.toRepresentation(schema.ast), {
      representation: { _tag: "Reference", $ref: "Suspend_" },
      references: {
        Suspend_: {
          _tag: "Suspend",
          thunk: { _tag: "Reference", $ref: "Suspend_" },
          checks: []
        }
      }
    })
  })
})
