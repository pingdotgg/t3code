import { Array as Arr, Option, Predicate, Schema, SchemaGetter, SchemaRepresentation } from "effect"
import { describe, it } from "vitest"
import { deepStrictEqual } from "../../utils/assert.ts"

describe("fromASTs", () => {
  function assertFromASTs(schemas: readonly [Schema.Top, ...Array<Schema.Top>], expected: {
    readonly representations: readonly [
      SchemaRepresentation.Representation,
      ...Array<SchemaRepresentation.Representation>
    ]
    readonly references?: SchemaRepresentation.References
  }) {
    const document = SchemaRepresentation.fromASTs(Arr.map(schemas, (s) => s.ast))
    deepStrictEqual(document, {
      representations: expected.representations,
      references: expected.references ?? {}
    })
  }

  it("should handle multiple schemas", () => {
    const A = Schema.String.annotate({ identifier: "id", description: "a" })
    const B = Schema.String.annotate({ identifier: "id", description: "b" })
    const C = Schema.Tuple([A, B])
    assertFromASTs([A, B, C], {
      representations: [
        { _tag: "Reference", $ref: "id" },
        { _tag: "Reference", $ref: "id1" },
        {
          _tag: "Arrays",
          elements: [
            {
              isOptional: false,
              type: { _tag: "Reference", $ref: "id" }
            },
            {
              isOptional: false,
              type: { _tag: "Reference", $ref: "id1" }
            }
          ],
          rest: [],
          checks: []
        }
      ],
      references: {
        id: {
          _tag: "String",
          checks: [],
          annotations: { identifier: "id", description: "a" }
        },
        id1: {
          _tag: "String",
          checks: [],
          annotations: { identifier: "id", description: "b" }
        }
      }
    })
  })
})

describe("fromAST", () => {
  function assertFromAST(schema: Schema.Top, expected: {
    readonly representation: SchemaRepresentation.Representation
    readonly references?: SchemaRepresentation.References
  }) {
    const document = SchemaRepresentation.fromAST(schema.ast)
    deepStrictEqual(document, {
      representation: expected.representation,
      references: expected.references ?? {}
    })
  }

  describe("String", () => {
    it("String", () => {
      assertFromAST(Schema.String, {
        representation: {
          _tag: "String",
          checks: []
        }
      })
    })

    it("String & brand", () => {
      assertFromAST(Schema.String.pipe(Schema.brand("a")), {
        representation: {
          _tag: "String",
          checks: [],
          annotations: { brands: ["a"] }
        }
      })
    })

    it("String & brand & brand", () => {
      assertFromAST(Schema.String.pipe(Schema.brand("a"), Schema.brand("b")), {
        representation: {
          _tag: "String",
          checks: [],
          annotations: { brands: ["a", "b"] }
        }
      })
    })
  })

  it("URL", () => {
    assertFromAST(Schema.URL, {
      representation: {
        _tag: "Declaration",
        annotations: {
          expected: "URL",
          typeConstructor: { _tag: "URL" },
          generation: {
            runtime: "Schema.URL",
            Type: "globalThis.URL"
          }
        },
        checks: [],
        typeParameters: [],
        encodedSchema: {
          _tag: "String",
          annotations: {
            expected: "a string that will be decoded as a URL"
          },
          checks: []
        }
      }
    })
  })

  it("RegExp", () => {
    assertFromAST(Schema.RegExp, {
      representation: {
        _tag: "Declaration",
        annotations: {
          expected: "RegExp",
          typeConstructor: { _tag: "RegExp" },
          generation: {
            runtime: "Schema.RegExp",
            Type: "globalThis.RegExp"
          }
        },
        checks: [],
        typeParameters: [],
        encodedSchema: {
          _tag: "Objects",
          propertySignatures: [
            {
              name: "source",
              type: { _tag: "String", checks: [] },
              isOptional: false,
              isMutable: false
            },
            {
              name: "flags",
              type: { _tag: "String", checks: [] },
              isOptional: false,
              isMutable: false
            }
          ],
          indexSignatures: [],
          checks: []
        }
      }
    })
  })

  it("URLSearchParams", () => {
    assertFromAST(Schema.URLSearchParams, {
      representation: {
        _tag: "Declaration",
        annotations: {
          expected: "URLSearchParams",
          typeConstructor: { _tag: "URLSearchParams" },
          generation: {
            runtime: "Schema.URLSearchParams",
            Type: "globalThis.URLSearchParams"
          }
        },
        checks: [],
        typeParameters: [],
        encodedSchema: {
          _tag: "String",
          annotations: {
            expected: "a query string that will be decoded as URLSearchParams"
          },
          checks: []
        }
      }
    })
  })

  it("Option(Number)", () => {
    assertFromAST(Schema.Option(Schema.Number), {
      representation: {
        _tag: "Declaration",
        annotations: {
          expected: "Option",
          typeConstructor: { _tag: "effect/Option" },
          generation: {
            runtime: "Schema.Option(?)",
            Type: "Option.Option<?>",
            importDeclaration: `import * as Option from "effect/Option"`
          }
        },
        checks: [],
        typeParameters: [
          { _tag: "Number", checks: [] }
        ],
        encodedSchema: {
          _tag: "Union",
          types: [
            {
              _tag: "Objects",
              propertySignatures: [
                {
                  name: "_tag",
                  type: { _tag: "Literal", literal: "Some" },
                  isOptional: false,
                  isMutable: false
                },
                {
                  name: "value",
                  type: { _tag: "Number", checks: [] },
                  isOptional: false,
                  isMutable: false
                }
              ],
              indexSignatures: [],
              checks: []
            },
            {
              _tag: "Objects",
              propertySignatures: [
                {
                  name: "_tag",
                  type: { _tag: "Literal", literal: "None" },
                  isOptional: false,
                  isMutable: false
                }
              ],
              indexSignatures: [],
              checks: []
            }
          ],
          mode: "anyOf"
        }
      }
    })
  })

  describe("Record", () => {
    describe("checks", () => {
      it("isPropertyNames", () => {
        assertFromAST(
          Schema.Record(Schema.String, Schema.Number)
            .check(Schema.isPropertyNames(Schema.String.check(Schema.isPattern(/^[A-Z]/)))),
          {
            representation: {
              _tag: "Objects",
              propertySignatures: [],
              indexSignatures: [
                {
                  parameter: { _tag: "String", checks: [] },
                  type: { _tag: "Number", checks: [] }
                }
              ],
              checks: [
                {
                  _tag: "Filter",
                  meta: {
                    _tag: "isPropertyNames",
                    propertyNames: {
                      _tag: "String",
                      checks: [
                        {
                          _tag: "Filter",
                          meta: { _tag: "isPattern", regExp: new RegExp("^[A-Z]") },
                          annotations: { expected: "a string matching the RegExp ^[A-Z]" }
                        }
                      ]
                    }
                  },
                  annotations: { expected: "an object with property names matching the schema" }
                }
              ]
            },
            references: {}
          }
        )
      })
    })
  })

  describe("Class", () => {
    it("Class", () => {
      class A extends Schema.Class<A>("A")({
        a: Schema.String
      }) {}
      assertFromAST(A, {
        representation: { _tag: "Reference", $ref: "A" },
        references: {
          A: {
            _tag: "Objects",
            propertySignatures: [
              {
                name: "a",
                type: {
                  _tag: "String",
                  checks: []
                },
                isOptional: false,
                isMutable: false
              }
            ],
            indexSignatures: [],
            checks: []
          }
        }
      })
    })

    it("toType(Class)", () => {
      class A extends Schema.Class<A>("A")({
        a: Schema.String
      }) {}
      assertFromAST(Schema.toType(A), {
        representation: { _tag: "Reference", $ref: "A" },
        references: {
          A: {
            _tag: "Declaration",
            annotations: {
              identifier: "A"
            },
            checks: [],
            typeParameters: [
              { _tag: "Reference", $ref: "A1" }
            ],
            encodedSchema: { _tag: "Reference", $ref: "A1" }
          },
          A1: {
            _tag: "Objects",
            propertySignatures: [
              {
                name: "a",
                type: {
                  _tag: "String",
                  checks: []
                },
                isOptional: false,
                isMutable: false
              }
            ],
            indexSignatures: [],
            checks: []
          }
        }
      })
    })

    it("the type side and the class used together", () => {
      class A extends Schema.Class<A>("A")({
        a: Schema.String
      }) {}
      assertFromAST(Schema.Tuple([Schema.toType(A), A]), {
        representation: {
          _tag: "Arrays",
          elements: [
            {
              isOptional: false,
              type: { _tag: "Reference", $ref: "A" }
            },
            {
              isOptional: false,
              type: { _tag: "Reference", $ref: "A1" }
            }
          ],
          rest: [],
          checks: []
        },
        references: {
          A: {
            _tag: "Declaration",
            annotations: { identifier: "A" },
            checks: [],
            typeParameters: [
              { _tag: "Reference", $ref: "A1" }
            ],
            encodedSchema: { _tag: "Reference", $ref: "A1" }
          },
          A1: {
            _tag: "Objects",
            propertySignatures: [
              {
                name: "a",
                type: {
                  _tag: "String",
                  checks: []
                },
                isOptional: false,
                isMutable: false
              }
            ],
            indexSignatures: [],
            checks: []
          }
        }
      })
    })
  })

  describe("reference handling", () => {
    it("using a schema with an identifier twice should point to the identifier as a reference", () => {
      const S = Schema.String.annotate({ identifier: "id" })
      assertFromAST(Schema.Tuple([S, S]), {
        representation: {
          _tag: "Arrays",
          elements: [
            {
              isOptional: false,
              type: { _tag: "Reference", $ref: "id" }
            },
            {
              isOptional: false,
              type: { _tag: "Reference", $ref: "id" }
            }
          ],
          rest: [],
          checks: []
        },
        references: {
          id: {
            _tag: "String",
            checks: [],
            annotations: { identifier: "id" }
          }
        }
      })
    })

    it("should handle duplicate identifiers on different schemas with different representations", () => {
      assertFromAST(
        Schema.Union([
          Schema.String.annotate({ identifier: "id", description: "a" }),
          Schema.String.annotate({ identifier: "id", description: "b" })
        ]),
        {
          representation: {
            _tag: "Union",
            mode: "anyOf",
            types: [
              { _tag: "Reference", $ref: "id" },
              { _tag: "Reference", $ref: "id1" }
            ]
          },
          references: {
            id: {
              _tag: "String",
              checks: [],
              annotations: { identifier: "id", description: "a" }
            },
            id1: {
              _tag: "String",
              checks: [],
              annotations: { identifier: "id", description: "b" }
            }
          }
        }
      )
    })

    it("should handle duplicate identifiers on different schemas with the same representation", () => {
      const X = Schema.String.annotate({ title: "X", identifier: "X" })
      assertFromAST(
        Schema.Struct({
          a: X,
          b: Schema.NullOr(X),
          c: Schema.optionalKey(X),
          d: Schema.optionalKey(Schema.NullOr(X)),
          e: Schema.NullOr(X).pipe(
            Schema.encodeTo(Schema.optionalKey(X), {
              decode: SchemaGetter.transformOptional(Option.orElseSome(() => null)),
              encode: SchemaGetter.transformOptional(Option.filter(Predicate.isNotNull))
            })
          )
        }),
        {
          representation: {
            _tag: "Objects",
            propertySignatures: [
              {
                name: "a",
                type: { _tag: "Reference", $ref: "X" },
                isOptional: false,
                isMutable: false
              },
              {
                name: "b",
                type: {
                  _tag: "Union",
                  mode: "anyOf",
                  types: [
                    { _tag: "Reference", $ref: "X" },
                    { _tag: "Null" }
                  ]
                },
                isOptional: false,
                isMutable: false
              },
              {
                name: "c",
                type: { _tag: "Reference", $ref: "X" },
                isOptional: true,
                isMutable: false
              },
              {
                name: "d",
                type: {
                  _tag: "Union",
                  mode: "anyOf",
                  types: [
                    { _tag: "Reference", $ref: "X" },
                    { _tag: "Null" }
                  ]
                },
                isOptional: true,
                isMutable: false
              },
              {
                name: "e",
                type: { _tag: "Reference", $ref: "X" },
                isOptional: true,
                isMutable: false
              }
            ],
            indexSignatures: [],
            checks: []
          },
          references: {
            X: {
              _tag: "String",
              checks: [],
              annotations: { identifier: "X", title: "X" }
            }
          }
        }
      )
    })

    describe("suspend", () => {
      it("non-recursive", () => {
        assertFromAST(Schema.suspend(() => Schema.String), {
          representation: {
            _tag: "Suspend",
            checks: [],
            thunk: {
              _tag: "String",
              checks: []
            }
          }
        })
      })

      it("no identifier annotation", () => {
        type A = {
          readonly a?: A
        }
        const A = Schema.Struct({
          a: Schema.optionalKey(Schema.suspend((): Schema.Codec<A> => A))
        })

        assertFromAST(A, {
          representation: { _tag: "Reference", $ref: "Objects_" },
          references: {
            Objects_: {
              _tag: "Objects",
              propertySignatures: [
                {
                  name: "a",
                  type: {
                    _tag: "Suspend",
                    checks: [],
                    thunk: { _tag: "Reference", $ref: "Objects_" }
                  },
                  isOptional: true,
                  isMutable: false
                }
              ],
              indexSignatures: [],
              checks: []
            }
          }
        })
      })

      it("outer identifier annotation", () => {
        type A = {
          readonly a?: A
        }
        const A = Schema.Struct({
          a: Schema.optionalKey(Schema.suspend((): Schema.Codec<A> => A))
        }).annotate({ identifier: "A" }) // outer identifier annotation

        assertFromAST(A, {
          representation: { _tag: "Reference", $ref: "A" },
          references: {
            A: {
              _tag: "Objects",
              annotations: { identifier: "A" },
              propertySignatures: [
                {
                  name: "a",
                  type: {
                    _tag: "Suspend",
                    checks: [],
                    thunk: { _tag: "Reference", $ref: "A" }
                  },
                  isOptional: true,
                  isMutable: false
                }
              ],
              indexSignatures: [],
              checks: []
            }
          }
        })
      })

      it("inner identifier annotation", () => {
        type A = {
          readonly a?: A
        }
        const A = Schema.Struct({
          a: Schema.optionalKey(Schema.suspend((): Schema.Codec<A> => A.annotate({ identifier: "A" })))
        })

        assertFromAST(A, {
          representation: {
            _tag: "Objects",
            propertySignatures: [
              {
                name: "a",
                type: { _tag: "Reference", $ref: "Suspend_" },
                isOptional: true,
                isMutable: false
              }
            ],
            indexSignatures: [],
            checks: []
          },
          references: {
            A: {
              _tag: "Objects",
              annotations: { identifier: "A" },
              propertySignatures: [
                {
                  name: "a",
                  type: { _tag: "Reference", $ref: "Suspend_" },
                  isOptional: true,
                  isMutable: false
                }
              ],
              indexSignatures: [],
              checks: []
            },
            Suspend_: {
              _tag: "Suspend",
              checks: [],
              thunk: { _tag: "Reference", $ref: "A" }
            }
          }
        })
      })

      it("suspend identifier annotation", () => {
        type A = {
          readonly a?: A
        }
        const A = Schema.Struct({
          a: Schema.optionalKey(Schema.suspend((): Schema.Codec<A> => A).annotate({ identifier: "A" }))
        })

        assertFromAST(A, {
          representation: { _tag: "Reference", $ref: "Objects_" },
          references: {
            A: {
              _tag: "Suspend",
              annotations: { identifier: "A" },
              checks: [],
              thunk: { _tag: "Reference", $ref: "Objects_" }
            },
            Objects_: {
              _tag: "Objects",
              propertySignatures: [
                {
                  name: "a",
                  type: { _tag: "Reference", $ref: "A" },
                  isOptional: true,
                  isMutable: false
                }
              ],
              indexSignatures: [],
              checks: []
            }
          }
        })
      })

      it("duplicate identifiers", () => {
        type A = {
          readonly a?: A
        }
        const A = Schema.Struct({
          a: Schema.optionalKey(Schema.suspend((): Schema.Codec<A> => A))
        }).annotate({ identifier: "A" })

        type A1 = {
          readonly a?: A1
        }
        const A1 = Schema.Struct({
          a: Schema.optionalKey(Schema.suspend((): Schema.Codec<A1> => A1))
        }).annotate({ identifier: "A" })

        const schema = Schema.Tuple([A, A1])
        assertFromAST(schema, {
          representation: {
            _tag: "Arrays",
            elements: [
              {
                isOptional: false,
                type: { _tag: "Reference", $ref: "A" }
              },
              {
                isOptional: false,
                type: { _tag: "Reference", $ref: "A1" }
              }
            ],
            rest: [],
            checks: []
          },
          references: {
            A: {
              _tag: "Objects",
              annotations: { identifier: "A" },
              propertySignatures: [
                {
                  name: "a",
                  type: {
                    _tag: "Suspend",
                    checks: [],
                    thunk: { _tag: "Reference", $ref: "A" }
                  },
                  isOptional: true,
                  isMutable: false
                }
              ],
              indexSignatures: [],
              checks: []
            },
            A1: {
              _tag: "Objects",
              annotations: { identifier: "A" },
              propertySignatures: [
                {
                  name: "a",
                  type: {
                    _tag: "Suspend",
                    checks: [],
                    thunk: { _tag: "Reference", $ref: "A1" }
                  },
                  isOptional: true,
                  isMutable: false
                }
              ],
              indexSignatures: [],
              checks: []
            }
          }
        })
      })
    })

    describe("transformation schemas with identifiers", () => {
      it("Class", () => {
        class A extends Schema.Class<A>("A")({
          a: Schema.String
        }) {}
        assertFromAST(Schema.Tuple([A, A]), {
          representation: {
            _tag: "Arrays",
            elements: [
              {
                isOptional: false,
                type: { _tag: "Reference", $ref: "A" }
              },
              {
                isOptional: false,
                type: { _tag: "Reference", $ref: "A" }
              }
            ],
            rest: [],
            checks: []
          },
          references: {
            A: {
              _tag: "Objects",
              propertySignatures: [
                {
                  name: "a",
                  type: { _tag: "String", checks: [] },
                  isOptional: false,
                  isMutable: false
                }
              ],
              indexSignatures: [],
              checks: []
            }
          }
        })
      })
    })
  })
})
