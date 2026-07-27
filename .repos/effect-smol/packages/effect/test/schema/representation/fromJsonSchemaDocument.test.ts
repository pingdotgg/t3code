import { JsonSchema, Schema, SchemaRepresentation } from "effect"
import { describe, it } from "vitest"
import { assertFalse, assertTrue, deepStrictEqual, strictEqual, throws } from "../../utils/assert.ts"

function toSchemaFromJsonSchemaDocument(
  document: JsonSchema.Document<"draft-2020-12">,
  options?: SchemaRepresentation.FromJsonSchemaOptions
): Schema.Top {
  return SchemaRepresentation.fromJsonSchemaDocument(document, options)
}

function fromJsonSchemaRepresentation(
  document: JsonSchema.Document<"draft-2020-12">,
  options?: SchemaRepresentation.FromJsonSchemaOptions
): SchemaRepresentation.Document {
  return SchemaRepresentation.toRepresentation(SchemaRepresentation.fromJsonSchemaDocument(document, options).ast)
}

describe("fromJsonSchemaDocument", () => {
  function assertFromJsonSchema(
    input: {
      readonly schema: JsonSchema.JsonSchema
      readonly options?: SchemaRepresentation.FromJsonSchemaOptions
    },
    expected: Schema.Json
  ) {
    const jsonDocument = JsonSchema.fromSchemaDraft2020_12(input.schema)
    const schema = SchemaRepresentation.fromJsonSchemaDocument(jsonDocument, input.options)
    const document = SchemaRepresentation.toRepresentation(schema.ast)
    deepStrictEqual(SchemaRepresentation.toJson(document), expected)
    return schema
  }

  it("{}", () => {
    assertFromJsonSchema(
      { schema: {} },
      {
        "representation": {
          "_tag": "Declaration",
          "representation": {
            "id": "effect/schema/Json",
            "payload": null
          },
          "annotations": {
            "expected": "JSON value"
          },
          "typeParameters": [],
          "checks": []
        },
        "references": {}
      }
    )
    assertFromJsonSchema(
      {
        schema: {
          title: "a",
          description: "b",
          default: "c",
          examples: ["d"],
          readOnly: true,
          writeOnly: true
        }
      },
      {
        "representation": {
          "_tag": "Declaration",
          "representation": {
            "id": "effect/schema/Json",
            "payload": null
          },
          "annotations": {
            "expected": "JSON value",
            "title": "a",
            "description": "b",
            "default": "c",
            "examples": [
              "d"
            ],
            "readOnly": true,
            "writeOnly": true
          },
          "typeParameters": [],
          "checks": []
        },
        "references": {}
      }
    )
  })

  describe("const", () => {
    it("const: literal (string)", () => {
      assertFromJsonSchema(
        { schema: { const: "a" } },
        {
          "representation": {
            "_tag": "Literal",
            "checks": [],
            "literal": {
              "type": "string",
              "value": "a"
            }
          },
          "references": {}
        }
      )
      assertFromJsonSchema(
        { schema: { const: "a", description: "a" } },
        {
          "representation": {
            "_tag": "Literal",
            "annotations": {
              "description": "a"
            },
            "checks": [],
            "literal": {
              "type": "string",
              "value": "a"
            }
          },
          "references": {}
        }
      )
    })

    it("const: literal (number)", () => {
      assertFromJsonSchema(
        { schema: { const: 1 } },
        {
          "representation": {
            "_tag": "Literal",
            "checks": [],
            "literal": {
              "type": "number",
              "value": 1
            }
          },
          "references": {}
        }
      )
    })

    it("const: literal (boolean)", () => {
      assertFromJsonSchema(
        { schema: { const: true } },
        {
          "representation": {
            "_tag": "Literal",
            "checks": [],
            "literal": {
              "type": "boolean",
              "value": true
            }
          },
          "references": {}
        }
      )
    })

    it("const: null", () => {
      assertFromJsonSchema(
        { schema: { const: null } },
        {
          "representation": {
            "_tag": "Null",
            "checks": []
          },
          "references": {}
        }
      )
      assertFromJsonSchema(
        { schema: { const: null, description: "a" } },
        {
          "representation": {
            "_tag": "Null",
            "annotations": {
              "description": "a"
            },
            "checks": []
          },
          "references": {}
        }
      )
    })

    it("const: non-literal", () => {
      assertFromJsonSchema(
        { schema: { const: {} } },
        {
          "representation": {
            "_tag": "Declaration",
            "representation": {
              "id": "effect/schema/Json",
              "payload": null
            },
            "annotations": {
              "expected": "JSON value"
            },
            "typeParameters": [],
            "checks": []
          },
          "references": {}
        }
      )
    })
  })

  describe("enum", () => {
    it("single enum (string)", () => {
      assertFromJsonSchema(
        { schema: { enum: ["a"] } },
        {
          "representation": {
            "_tag": "Literal",
            "checks": [],
            "literal": {
              "type": "string",
              "value": "a"
            }
          },
          "references": {}
        }
      )
      assertFromJsonSchema(
        { schema: { enum: ["a"], description: "a" } },
        {
          "representation": {
            "_tag": "Literal",
            "annotations": {
              "description": "a"
            },
            "checks": [],
            "literal": {
              "type": "string",
              "value": "a"
            }
          },
          "references": {}
        }
      )
    })

    it("single enum (number)", () => {
      assertFromJsonSchema(
        { schema: { enum: [1] } },
        {
          "representation": {
            "_tag": "Literal",
            "checks": [],
            "literal": {
              "type": "number",
              "value": 1
            }
          },
          "references": {}
        }
      )
    })

    it("single enum (boolean)", () => {
      assertFromJsonSchema(
        { schema: { enum: [true] } },
        {
          "representation": {
            "_tag": "Literal",
            "checks": [],
            "literal": {
              "type": "boolean",
              "value": true
            }
          },
          "references": {}
        }
      )
    })

    it("multiple enum (literals)", () => {
      assertFromJsonSchema(
        { schema: { enum: ["a", 1] } },
        {
          "representation": {
            "_tag": "Union",
            "checks": [],
            "types": [
              {
                "_tag": "Literal",
                "checks": [],
                "literal": {
                  "type": "string",
                  "value": "a"
                }
              },
              {
                "_tag": "Literal",
                "checks": [],
                "literal": {
                  "type": "number",
                  "value": 1
                }
              }
            ],
            "mode": "anyOf"
          },
          "references": {}
        }
      )
      assertFromJsonSchema(
        { schema: { enum: ["a", 1], description: "a" } },
        {
          "representation": {
            "_tag": "Union",
            "annotations": {
              "description": "a"
            },
            "checks": [],
            "types": [
              {
                "_tag": "Literal",
                "checks": [],
                "literal": {
                  "type": "string",
                  "value": "a"
                }
              },
              {
                "_tag": "Literal",
                "checks": [],
                "literal": {
                  "type": "number",
                  "value": 1
                }
              }
            ],
            "mode": "anyOf"
          },
          "references": {}
        }
      )
    })

    it("enum containing null", () => {
      assertFromJsonSchema(
        { schema: { enum: ["a", null] } },
        {
          "representation": {
            "_tag": "Union",
            "checks": [],
            "types": [
              {
                "_tag": "Literal",
                "checks": [],
                "literal": {
                  "type": "string",
                  "value": "a"
                }
              },
              {
                "_tag": "Null",
                "checks": []
              }
            ],
            "mode": "anyOf"
          },
          "references": {}
        }
      )
    })
  })

  it("anyOf", () => {
    assertFromJsonSchema(
      { schema: { anyOf: [{ const: "a" }, { enum: [1, 2] }] } },
      {
        "representation": {
          "_tag": "Union",
          "checks": [],
          "types": [
            {
              "_tag": "Literal",
              "checks": [],
              "literal": {
                "type": "string",
                "value": "a"
              }
            },
            {
              "_tag": "Union",
              "checks": [],
              "types": [
                {
                  "_tag": "Literal",
                  "checks": [],
                  "literal": {
                    "type": "number",
                    "value": 1
                  }
                },
                {
                  "_tag": "Literal",
                  "checks": [],
                  "literal": {
                    "type": "number",
                    "value": 2
                  }
                }
              ],
              "mode": "anyOf"
            }
          ],
          "mode": "anyOf"
        },
        "references": {}
      }
    )
  })

  it("anyOf with siblings", () => {
    assertFromJsonSchema(
      {
        schema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          anyOf: [
            { properties: { a: { type: "string" } }, required: ["a"] },
            { properties: { b: { type: "number" } }, required: ["b"] }
          ]
        }
      },
      {
        "representation": {
          "_tag": "Union",
          "checks": [],
          "types": [
            {
              "_tag": "Objects",
              "checks": [],
              "propertySignatures": [
                {
                  "name": {
                    "type": "string",
                    "value": "a"
                  },
                  "type": {
                    "_tag": "String",
                    "checks": []
                  },
                  "isOptional": false,
                  "isMutable": false
                },
                {
                  "name": {
                    "type": "string",
                    "value": "id"
                  },
                  "type": {
                    "_tag": "String",
                    "checks": []
                  },
                  "isOptional": false,
                  "isMutable": false
                }
              ],
              "indexSignatures": [
                {
                  "parameter": {
                    "_tag": "String",
                    "checks": []
                  },
                  "type": {
                    "_tag": "Declaration",
                    "representation": {
                      "id": "effect/schema/Json",
                      "payload": null
                    },
                    "annotations": {
                      "expected": "JSON value"
                    },
                    "typeParameters": [],
                    "checks": []
                  }
                }
              ]
            },
            {
              "_tag": "Objects",
              "checks": [],
              "propertySignatures": [
                {
                  "name": {
                    "type": "string",
                    "value": "b"
                  },
                  "type": {
                    "_tag": "Number",
                    "checks": [
                      {
                        "_tag": "Filter",
                        "representation": {
                          "id": "effect/schema/isFinite",
                          "payload": null
                        },
                        "annotations": {
                          "expected": "a finite number",
                          "arbitrary": {
                            "constraint": {
                              "noInfinity": true,
                              "noNaN": true
                            }
                          }
                        },
                        "aborted": false
                      }
                    ]
                  },
                  "isOptional": false,
                  "isMutable": false
                },
                {
                  "name": {
                    "type": "string",
                    "value": "id"
                  },
                  "type": {
                    "_tag": "String",
                    "checks": []
                  },
                  "isOptional": false,
                  "isMutable": false
                }
              ],
              "indexSignatures": [
                {
                  "parameter": {
                    "_tag": "String",
                    "checks": []
                  },
                  "type": {
                    "_tag": "Declaration",
                    "representation": {
                      "id": "effect/schema/Json",
                      "payload": null
                    },
                    "annotations": {
                      "expected": "JSON value"
                    },
                    "typeParameters": [],
                    "checks": []
                  }
                }
              ]
            }
          ],
          "mode": "anyOf"
        },
        "references": {}
      }
    )
  })

  it("oneOf", () => {
    assertFromJsonSchema(
      { schema: { oneOf: [{ const: "a" }, { enum: [1, 2] }] } },
      {
        "representation": {
          "_tag": "Union",
          "checks": [],
          "types": [
            {
              "_tag": "Literal",
              "checks": [],
              "literal": {
                "type": "string",
                "value": "a"
              }
            },
            {
              "_tag": "Union",
              "checks": [],
              "types": [
                {
                  "_tag": "Literal",
                  "checks": [],
                  "literal": {
                    "type": "number",
                    "value": 1
                  }
                },
                {
                  "_tag": "Literal",
                  "checks": [],
                  "literal": {
                    "type": "number",
                    "value": 2
                  }
                }
              ],
              "mode": "anyOf"
            }
          ],
          "mode": "oneOf"
        },
        "references": {}
      }
    )
  })

  it("oneOf with siblings", () => {
    assertFromJsonSchema(
      {
        schema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          oneOf: [
            { properties: { a: { type: "string" } }, required: ["a"] },
            { properties: { b: { type: "number" } }, required: ["b"] }
          ]
        }
      },
      {
        "representation": {
          "_tag": "Union",
          "checks": [],
          "types": [
            {
              "_tag": "Objects",
              "checks": [],
              "propertySignatures": [
                {
                  "name": {
                    "type": "string",
                    "value": "a"
                  },
                  "type": {
                    "_tag": "String",
                    "checks": []
                  },
                  "isOptional": false,
                  "isMutable": false
                },
                {
                  "name": {
                    "type": "string",
                    "value": "id"
                  },
                  "type": {
                    "_tag": "String",
                    "checks": []
                  },
                  "isOptional": false,
                  "isMutable": false
                }
              ],
              "indexSignatures": [
                {
                  "parameter": {
                    "_tag": "String",
                    "checks": []
                  },
                  "type": {
                    "_tag": "Declaration",
                    "representation": {
                      "id": "effect/schema/Json",
                      "payload": null
                    },
                    "annotations": {
                      "expected": "JSON value"
                    },
                    "typeParameters": [],
                    "checks": []
                  }
                }
              ]
            },
            {
              "_tag": "Objects",
              "checks": [],
              "propertySignatures": [
                {
                  "name": {
                    "type": "string",
                    "value": "b"
                  },
                  "type": {
                    "_tag": "Number",
                    "checks": [
                      {
                        "_tag": "Filter",
                        "representation": {
                          "id": "effect/schema/isFinite",
                          "payload": null
                        },
                        "annotations": {
                          "expected": "a finite number",
                          "arbitrary": {
                            "constraint": {
                              "noInfinity": true,
                              "noNaN": true
                            }
                          }
                        },
                        "aborted": false
                      }
                    ]
                  },
                  "isOptional": false,
                  "isMutable": false
                },
                {
                  "name": {
                    "type": "string",
                    "value": "id"
                  },
                  "type": {
                    "_tag": "String",
                    "checks": []
                  },
                  "isOptional": false,
                  "isMutable": false
                }
              ],
              "indexSignatures": [
                {
                  "parameter": {
                    "_tag": "String",
                    "checks": []
                  },
                  "type": {
                    "_tag": "Declaration",
                    "representation": {
                      "id": "effect/schema/Json",
                      "payload": null
                    },
                    "annotations": {
                      "expected": "JSON value"
                    },
                    "typeParameters": [],
                    "checks": []
                  }
                }
              ]
            }
          ],
          "mode": "oneOf"
        },
        "references": {}
      }
    )
  })

  describe("type: null", () => {
    it("type only", () => {
      assertFromJsonSchema(
        { schema: { type: "null" } },
        {
          "representation": {
            "_tag": "Null",
            "checks": []
          },
          "references": {}
        }
      )
    })
  })

  describe("type: string", () => {
    it("type only", () => {
      assertFromJsonSchema(
        { schema: { type: "string" } },
        {
          "representation": {
            "_tag": "String",
            "checks": []
          },
          "references": {}
        }
      )
    })

    describe("checks", () => {
      it("minLength", () => {
        assertFromJsonSchema(
          { schema: { type: "string", minLength: 1 } },
          {
            "representation": {
              "_tag": "String",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMinLength",
                    "payload": {
                      "minLength": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at least 1",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "minLength": 1
                      }
                    }
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("maxLength", () => {
        assertFromJsonSchema(
          { schema: { type: "string", maxLength: 1 } },
          {
            "representation": {
              "_tag": "String",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMaxLength",
                    "payload": {
                      "maxLength": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at most 1",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "maxLength": 1
                      }
                    }
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("pattern", () => {
        assertFromJsonSchema(
          { schema: { type: "string", pattern: "a*" } },
          {
            "representation": {
              "_tag": "String",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isPattern",
                    "payload": {
                      "source": "a*",
                      "flags": ""
                    }
                  },
                  "annotations": {
                    "expected": "a string matching the RegExp a*",
                    "arbitrary": {
                      "constraint": {
                        "patterns": [
                          "a*"
                        ]
                      }
                    }
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
        assertFromJsonSchema(
          { schema: { pattern: "a*" } },
          {
            "representation": {
              "_tag": "String",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isPattern",
                    "payload": {
                      "source": "a*",
                      "flags": ""
                    }
                  },
                  "annotations": {
                    "expected": "a string matching the RegExp a*",
                    "arbitrary": {
                      "constraint": {
                        "patterns": [
                          "a*"
                        ]
                      }
                    }
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })
    })
  })

  describe("type: number", () => {
    it("type only", () => {
      assertFromJsonSchema(
        { schema: { type: "number" } },
        {
          "representation": {
            "_tag": "Number",
            "checks": [
              {
                "_tag": "Filter",
                "representation": {
                  "id": "effect/schema/isFinite",
                  "payload": null
                },
                "annotations": {
                  "expected": "a finite number",
                  "arbitrary": {
                    "constraint": {
                      "noInfinity": true,
                      "noNaN": true
                    }
                  }
                },
                "aborted": false
              }
            ]
          },
          "references": {}
        }
      )
    })

    describe("checks", () => {
      it("minimum", () => {
        assertFromJsonSchema(
          { schema: { type: "number", minimum: 1 } },
          {
            "representation": {
              "_tag": "Number",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isFinite",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "a finite number",
                    "arbitrary": {
                      "constraint": {
                        "noInfinity": true,
                        "noNaN": true
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isGreaterThanOrEqualTo",
                    "payload": {
                      "minimum": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value greater than or equal to 1"
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("maximum", () => {
        assertFromJsonSchema(
          { schema: { type: "number", maximum: 1 } },
          {
            "representation": {
              "_tag": "Number",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isFinite",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "a finite number",
                    "arbitrary": {
                      "constraint": {
                        "noInfinity": true,
                        "noNaN": true
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isLessThanOrEqualTo",
                    "payload": {
                      "maximum": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value less than or equal to 1"
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("exclusiveMinimum", () => {
        assertFromJsonSchema(
          { schema: { type: "number", exclusiveMinimum: 1 } },
          {
            "representation": {
              "_tag": "Number",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isFinite",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "a finite number",
                    "arbitrary": {
                      "constraint": {
                        "noInfinity": true,
                        "noNaN": true
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isGreaterThan",
                    "payload": {
                      "exclusiveMinimum": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value greater than 1"
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("exclusiveMaximum", () => {
        assertFromJsonSchema(
          { schema: { type: "number", exclusiveMaximum: 1 } },
          {
            "representation": {
              "_tag": "Number",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isFinite",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "a finite number",
                    "arbitrary": {
                      "constraint": {
                        "noInfinity": true,
                        "noNaN": true
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isLessThan",
                    "payload": {
                      "exclusiveMaximum": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value less than 1"
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("multipleOf", () => {
        assertFromJsonSchema(
          { schema: { type: "number", multipleOf: 1 } },
          {
            "representation": {
              "_tag": "Number",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isFinite",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "a finite number",
                    "arbitrary": {
                      "constraint": {
                        "noInfinity": true,
                        "noNaN": true
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMultipleOf",
                    "payload": {
                      "divisor": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value that is a multiple of 1"
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })
    })
  })

  describe("type: integer", () => {
    it("type only", () => {
      assertFromJsonSchema(
        { schema: { type: "integer" } },
        {
          "representation": {
            "_tag": "Number",
            "checks": [
              {
                "_tag": "Filter",
                "representation": {
                  "id": "effect/schema/isInt",
                  "payload": null
                },
                "annotations": {
                  "expected": "an integer",
                  "arbitrary": {
                    "constraint": {
                      "integer": true
                    }
                  }
                },
                "aborted": false
              }
            ]
          },
          "references": {}
        }
      )
    })

    describe("checks", () => {
      it("minimum", () => {
        assertFromJsonSchema(
          { schema: { type: "integer", minimum: 1 } },
          {
            "representation": {
              "_tag": "Number",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isInt",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "an integer",
                    "arbitrary": {
                      "constraint": {
                        "integer": true
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isGreaterThanOrEqualTo",
                    "payload": {
                      "minimum": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value greater than or equal to 1"
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("maximum", () => {
        assertFromJsonSchema(
          { schema: { type: "integer", maximum: 1 } },
          {
            "representation": {
              "_tag": "Number",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isInt",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "an integer",
                    "arbitrary": {
                      "constraint": {
                        "integer": true
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isLessThanOrEqualTo",
                    "payload": {
                      "maximum": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value less than or equal to 1"
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("exclusiveMinimum", () => {
        assertFromJsonSchema(
          { schema: { type: "integer", exclusiveMinimum: 1 } },
          {
            "representation": {
              "_tag": "Number",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isInt",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "an integer",
                    "arbitrary": {
                      "constraint": {
                        "integer": true
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isGreaterThan",
                    "payload": {
                      "exclusiveMinimum": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value greater than 1"
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("exclusiveMaximum", () => {
        assertFromJsonSchema(
          { schema: { type: "integer", exclusiveMaximum: 1 } },
          {
            "representation": {
              "_tag": "Number",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isInt",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "an integer",
                    "arbitrary": {
                      "constraint": {
                        "integer": true
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isLessThan",
                    "payload": {
                      "exclusiveMaximum": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value less than 1"
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("multipleOf", () => {
        assertFromJsonSchema(
          { schema: { type: "integer", multipleOf: 1 } },
          {
            "representation": {
              "_tag": "Number",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isInt",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "an integer",
                    "arbitrary": {
                      "constraint": {
                        "integer": true
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMultipleOf",
                    "payload": {
                      "divisor": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value that is a multiple of 1"
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })
    })
  })

  describe("type: boolean", () => {
    it("type only", () => {
      assertFromJsonSchema(
        { schema: { type: "boolean" } },
        {
          "representation": {
            "_tag": "Boolean",
            "checks": []
          },
          "references": {}
        }
      )
    })
  })

  describe("type: array", () => {
    it("type only", () => {
      assertFromJsonSchema(
        { schema: { type: "array" } },
        {
          "representation": {
            "_tag": "Arrays",
            "checks": [],
            "elements": [],
            "rest": [
              {
                "_tag": "Declaration",
                "representation": {
                  "id": "effect/schema/Json",
                  "payload": null
                },
                "annotations": {
                  "expected": "JSON value"
                },
                "typeParameters": [],
                "checks": []
              }
            ]
          },
          "references": {}
        }
      )
    })

    it("items", () => {
      assertFromJsonSchema(
        {
          schema: {
            type: "array",
            items: { type: "string" }
          }
        },
        {
          "representation": {
            "_tag": "Arrays",
            "checks": [],
            "elements": [],
            "rest": [
              {
                "_tag": "String",
                "checks": []
              }
            ]
          },
          "references": {}
        }
      )
    })

    it("prefixItems", () => {
      assertFromJsonSchema(
        {
          schema: {
            type: "array",
            prefixItems: [{ type: "string" }],
            maxItems: 1
          }
        },
        {
          "representation": {
            "_tag": "Arrays",
            "checks": [],
            "elements": [
              {
                "isOptional": true,
                "type": {
                  "_tag": "String",
                  "checks": []
                }
              }
            ],
            "rest": []
          },
          "references": {}
        }
      )

      assertFromJsonSchema(
        {
          schema: {
            type: "array",
            prefixItems: [{ type: "string" }],
            minItems: 1,
            maxItems: 1
          }
        },
        {
          "representation": {
            "_tag": "Arrays",
            "checks": [],
            "elements": [
              {
                "isOptional": false,
                "type": {
                  "_tag": "String",
                  "checks": []
                }
              }
            ],
            "rest": []
          },
          "references": {}
        }
      )
    })

    it("prefixItems & minItems", () => {
      assertFromJsonSchema(
        {
          schema: {
            type: "array",
            prefixItems: [{ type: "string" }],
            minItems: 1,
            items: { type: "number" }
          }
        },
        {
          "representation": {
            "_tag": "Arrays",
            "checks": [],
            "elements": [
              {
                "isOptional": false,
                "type": {
                  "_tag": "String",
                  "checks": []
                }
              }
            ],
            "rest": [
              {
                "_tag": "Number",
                "checks": [
                  {
                    "_tag": "Filter",
                    "representation": {
                      "id": "effect/schema/isFinite",
                      "payload": null
                    },
                    "annotations": {
                      "expected": "a finite number",
                      "arbitrary": {
                        "constraint": {
                          "noInfinity": true,
                          "noNaN": true
                        }
                      }
                    },
                    "aborted": false
                  }
                ]
              }
            ]
          },
          "references": {}
        }
      )
    })

    describe("checks", () => {
      it("minItems", () => {
        assertFromJsonSchema(
          { schema: { type: "array", minItems: 1 } },
          {
            "representation": {
              "_tag": "Arrays",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMinLength",
                    "payload": {
                      "minLength": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at least 1",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "minLength": 1
                      }
                    }
                  },
                  "aborted": false
                }
              ],
              "elements": [],
              "rest": [
                {
                  "_tag": "Declaration",
                  "representation": {
                    "id": "effect/schema/Json",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "JSON value"
                  },
                  "typeParameters": [],
                  "checks": []
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("maxItems", () => {
        assertFromJsonSchema(
          { schema: { type: "array", maxItems: 1 } },
          {
            "representation": {
              "_tag": "Arrays",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMaxLength",
                    "payload": {
                      "maxLength": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at most 1",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "maxLength": 1
                      }
                    }
                  },
                  "aborted": false
                }
              ],
              "elements": [],
              "rest": [
                {
                  "_tag": "Declaration",
                  "representation": {
                    "id": "effect/schema/Json",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "JSON value"
                  },
                  "typeParameters": [],
                  "checks": []
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("uniqueItems", () => {
        assertFromJsonSchema(
          { schema: { type: "array", uniqueItems: true } },
          {
            "representation": {
              "_tag": "Arrays",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isUnique",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "an array with unique items",
                    "arbitrary": {
                      "constraint": {
                        "unique": true
                      }
                    }
                  },
                  "aborted": false
                }
              ],
              "elements": [],
              "rest": [
                {
                  "_tag": "Declaration",
                  "representation": {
                    "id": "effect/schema/Json",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "JSON value"
                  },
                  "typeParameters": [],
                  "checks": []
                }
              ]
            },
            "references": {}
          }
        )
      })
    })
  })

  describe("type: object", () => {
    it("type only", () => {
      assertFromJsonSchema(
        { schema: { type: "object" } },
        {
          "representation": {
            "_tag": "Objects",
            "checks": [],
            "propertySignatures": [],
            "indexSignatures": [
              {
                "parameter": {
                  "_tag": "String",
                  "checks": []
                },
                "type": {
                  "_tag": "Declaration",
                  "representation": {
                    "id": "effect/schema/Json",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "JSON value"
                  },
                  "typeParameters": [],
                  "checks": []
                }
              }
            ]
          },
          "references": {}
        }
      )
      assertFromJsonSchema(
        {
          schema: {
            type: "object",
            additionalProperties: false
          }
        },
        {
          "representation": {
            "_tag": "Objects",
            "checks": [],
            "propertySignatures": [],
            "indexSignatures": []
          },
          "references": {}
        }
      )
    })

    it("additionalProperties", () => {
      assertFromJsonSchema(
        {
          schema: {
            type: "object",
            additionalProperties: { type: "boolean" }
          }
        },
        {
          "representation": {
            "_tag": "Objects",
            "checks": [],
            "propertySignatures": [],
            "indexSignatures": [
              {
                "parameter": {
                  "_tag": "String",
                  "checks": []
                },
                "type": {
                  "_tag": "Boolean",
                  "checks": []
                }
              }
            ]
          },
          "references": {}
        }
      )
    })

    it("properties", () => {
      assertFromJsonSchema(
        {
          schema: {
            type: "object",
            properties: { a: { type: "string" }, b: { type: "string" } },
            required: ["a"],
            additionalProperties: false
          }
        },
        {
          "representation": {
            "_tag": "Objects",
            "checks": [],
            "propertySignatures": [
              {
                "name": {
                  "type": "string",
                  "value": "a"
                },
                "type": {
                  "_tag": "String",
                  "checks": []
                },
                "isOptional": false,
                "isMutable": false
              },
              {
                "name": {
                  "type": "string",
                  "value": "b"
                },
                "type": {
                  "_tag": "String",
                  "checks": []
                },
                "isOptional": true,
                "isMutable": false
              }
            ],
            "indexSignatures": []
          },
          "references": {}
        }
      )
    })

    it("properties & additionalProperties", () => {
      assertFromJsonSchema(
        {
          schema: {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
            additionalProperties: { type: "boolean" }
          }
        },
        {
          "representation": {
            "_tag": "Objects",
            "checks": [],
            "propertySignatures": [
              {
                "name": {
                  "type": "string",
                  "value": "a"
                },
                "type": {
                  "_tag": "String",
                  "checks": []
                },
                "isOptional": false,
                "isMutable": false
              }
            ],
            "indexSignatures": [
              {
                "parameter": {
                  "_tag": "String",
                  "checks": []
                },
                "type": {
                  "_tag": "Boolean",
                  "checks": []
                }
              }
            ]
          },
          "references": {}
        }
      )
    })

    it("patternProperties", () => {
      assertFromJsonSchema(
        {
          schema: {
            type: "object",
            patternProperties: {
              "a*": { type: "string" }
            },
            additionalProperties: false
          }
        },
        {
          "representation": {
            "_tag": "Objects",
            "checks": [],
            "propertySignatures": [],
            "indexSignatures": [
              {
                "parameter": {
                  "_tag": "String",
                  "checks": [
                    {
                      "_tag": "Filter",
                      "representation": {
                        "id": "effect/schema/isPattern",
                        "payload": {
                          "source": "a*",
                          "flags": ""
                        }
                      },
                      "annotations": {
                        "expected": "a string matching the RegExp a*",
                        "arbitrary": {
                          "constraint": {
                            "patterns": [
                              "a*"
                            ]
                          }
                        }
                      },
                      "aborted": false
                    }
                  ]
                },
                "type": {
                  "_tag": "String",
                  "checks": []
                }
              }
            ]
          },
          "references": {}
        }
      )
      assertFromJsonSchema(
        {
          schema: {
            type: "object",
            patternProperties: {
              "a*": { type: "string" },
              "b*": { type: "number" }
            },
            additionalProperties: false
          }
        },
        {
          "representation": {
            "_tag": "Objects",
            "checks": [],
            "propertySignatures": [],
            "indexSignatures": [
              {
                "parameter": {
                  "_tag": "String",
                  "checks": [
                    {
                      "_tag": "Filter",
                      "representation": {
                        "id": "effect/schema/isPattern",
                        "payload": {
                          "source": "a*",
                          "flags": ""
                        }
                      },
                      "annotations": {
                        "expected": "a string matching the RegExp a*",
                        "arbitrary": {
                          "constraint": {
                            "patterns": [
                              "a*"
                            ]
                          }
                        }
                      },
                      "aborted": false
                    }
                  ]
                },
                "type": {
                  "_tag": "String",
                  "checks": []
                }
              },
              {
                "parameter": {
                  "_tag": "String",
                  "checks": [
                    {
                      "_tag": "Filter",
                      "representation": {
                        "id": "effect/schema/isPattern",
                        "payload": {
                          "source": "b*",
                          "flags": ""
                        }
                      },
                      "annotations": {
                        "expected": "a string matching the RegExp b*",
                        "arbitrary": {
                          "constraint": {
                            "patterns": [
                              "b*"
                            ]
                          }
                        }
                      },
                      "aborted": false
                    }
                  ]
                },
                "type": {
                  "_tag": "Number",
                  "checks": [
                    {
                      "_tag": "Filter",
                      "representation": {
                        "id": "effect/schema/isFinite",
                        "payload": null
                      },
                      "annotations": {
                        "expected": "a finite number",
                        "arbitrary": {
                          "constraint": {
                            "noInfinity": true,
                            "noNaN": true
                          }
                        }
                      },
                      "aborted": false
                    }
                  ]
                }
              }
            ]
          },
          "references": {}
        }
      )
    })

    describe("checks", () => {
      it("minProperties", () => {
        assertFromJsonSchema(
          { schema: { type: "object", minProperties: 1 } },
          {
            "representation": {
              "_tag": "Objects",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMinProperties",
                    "payload": {
                      "minProperties": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value with at least 1 entry",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "minLength": 1
                      }
                    }
                  },
                  "aborted": false
                }
              ],
              "propertySignatures": [],
              "indexSignatures": [
                {
                  "parameter": {
                    "_tag": "String",
                    "checks": []
                  },
                  "type": {
                    "_tag": "Declaration",
                    "representation": {
                      "id": "effect/schema/Json",
                      "payload": null
                    },
                    "annotations": {
                      "expected": "JSON value"
                    },
                    "typeParameters": [],
                    "checks": []
                  }
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("maxProperties", () => {
        assertFromJsonSchema(
          { schema: { type: "object", maxProperties: 1 } },
          {
            "representation": {
              "_tag": "Objects",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMaxProperties",
                    "payload": {
                      "maxProperties": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value with at most 1 entry",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "maxLength": 1
                      }
                    }
                  },
                  "aborted": false
                }
              ],
              "propertySignatures": [],
              "indexSignatures": [
                {
                  "parameter": {
                    "_tag": "String",
                    "checks": []
                  },
                  "type": {
                    "_tag": "Declaration",
                    "representation": {
                      "id": "effect/schema/Json",
                      "payload": null
                    },
                    "annotations": {
                      "expected": "JSON value"
                    },
                    "typeParameters": [],
                    "checks": []
                  }
                }
              ]
            },
            "references": {}
          }
        )
      })
    })

    describe("propertyNames", () => {
      it("pattern", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "object",
              propertyNames: { pattern: "^[A-Z]" }
            }
          },
          {
            "representation": {
              "_tag": "Objects",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isPropertyNames",
                    "payload": null,
                    "schemas": [
                      {
                        "_tag": "String",
                        "checks": [
                          {
                            "_tag": "Filter",
                            "representation": {
                              "id": "effect/schema/isPattern",
                              "payload": {
                                "source": "^[A-Z]",
                                "flags": ""
                              }
                            },
                            "annotations": {
                              "expected": "a string matching the RegExp ^[A-Z]",
                              "arbitrary": {
                                "constraint": {
                                  "patterns": [
                                    "^[A-Z]"
                                  ]
                                }
                              }
                            },
                            "aborted": false
                          }
                        ]
                      }
                    ]
                  },
                  "annotations": {
                    "expected": "an object with property names matching the schema",
                    "~structural": true
                  },
                  "aborted": false
                }
              ],
              "propertySignatures": [],
              "indexSignatures": [
                {
                  "parameter": {
                    "_tag": "String",
                    "checks": []
                  },
                  "type": {
                    "_tag": "Declaration",
                    "representation": {
                      "id": "effect/schema/Json",
                      "payload": null
                    },
                    "annotations": {
                      "expected": "JSON value"
                    },
                    "typeParameters": [],
                    "checks": []
                  }
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("false", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "object",
              propertyNames: false
            }
          },
          {
            "representation": {
              "_tag": "Objects",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isPropertyNames",
                    "payload": null,
                    "schemas": [
                      {
                        "_tag": "Never",
                        "checks": []
                      }
                    ]
                  },
                  "annotations": {
                    "expected": "an object with property names matching the schema",
                    "~structural": true
                  },
                  "aborted": false
                }
              ],
              "propertySignatures": [],
              "indexSignatures": [
                {
                  "parameter": {
                    "_tag": "String",
                    "checks": []
                  },
                  "type": {
                    "_tag": "Declaration",
                    "representation": {
                      "id": "effect/schema/Json",
                      "payload": null
                    },
                    "annotations": {
                      "expected": "JSON value"
                    },
                    "typeParameters": [],
                    "checks": []
                  }
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("allOf combines checks", () => {
        assertFromJsonSchema(
          {
            schema: {
              allOf: [
                { type: "object", propertyNames: { pattern: "^[A-Z]" } },
                { type: "object", propertyNames: { minLength: 2 } }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Objects",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isPropertyNames",
                    "payload": null,
                    "schemas": [
                      {
                        "_tag": "String",
                        "checks": [
                          {
                            "_tag": "Filter",
                            "representation": {
                              "id": "effect/schema/isPattern",
                              "payload": {
                                "source": "^[A-Z]",
                                "flags": ""
                              }
                            },
                            "annotations": {
                              "expected": "a string matching the RegExp ^[A-Z]",
                              "arbitrary": {
                                "constraint": {
                                  "patterns": [
                                    "^[A-Z]"
                                  ]
                                }
                              }
                            },
                            "aborted": false
                          }
                        ]
                      }
                    ]
                  },
                  "annotations": {
                    "expected": "an object with property names matching the schema",
                    "~structural": true
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isPropertyNames",
                    "payload": null,
                    "schemas": [
                      {
                        "_tag": "String",
                        "checks": [
                          {
                            "_tag": "Filter",
                            "representation": {
                              "id": "effect/schema/isMinLength",
                              "payload": {
                                "minLength": 2
                              }
                            },
                            "annotations": {
                              "expected": "a value with a length of at least 2",
                              "~structural": true,
                              "arbitrary": {
                                "constraint": {
                                  "minLength": 2
                                }
                              }
                            },
                            "aborted": false
                          }
                        ]
                      }
                    ]
                  },
                  "annotations": {
                    "expected": "an object with property names matching the schema",
                    "~structural": true
                  },
                  "aborted": false
                }
              ],
              "propertySignatures": [],
              "indexSignatures": [
                {
                  "parameter": {
                    "_tag": "String",
                    "checks": []
                  },
                  "type": {
                    "_tag": "Declaration",
                    "representation": {
                      "id": "effect/schema/Json",
                      "payload": null
                    },
                    "annotations": {
                      "expected": "JSON value"
                    },
                    "typeParameters": [],
                    "checks": []
                  }
                }
              ]
            },
            "references": {}
          }
        )
      })
    })
  })

  it("type: array of strings", () => {
    assertFromJsonSchema(
      {
        schema: { type: ["string", "null"] }
      },
      {
        "representation": {
          "_tag": "Union",
          "checks": [],
          "types": [
            {
              "_tag": "String",
              "checks": []
            },
            {
              "_tag": "Null",
              "checks": []
            }
          ],
          "mode": "anyOf"
        },
        "references": {}
      }
    )
    assertFromJsonSchema(
      {
        schema: {
          type: ["string", "null"],
          description: "a"
        }
      },
      {
        "representation": {
          "_tag": "Union",
          "annotations": {
            "description": "a"
          },
          "checks": [],
          "types": [
            {
              "_tag": "String",
              "checks": []
            },
            {
              "_tag": "Null",
              "checks": []
            }
          ],
          "mode": "anyOf"
        },
        "references": {}
      }
    )
  })

  it("imports true schemas and structured enum members", () => {
    assertFromJsonSchema(
      { schema: { allOf: [true, { type: "string" }] } },
      {
        "representation": {
          "_tag": "String",
          "checks": []
        },
        "references": {}
      }
    )
    assertFromJsonSchema(
      { schema: { enum: [[], {}] } },
      {
        "representation": {
          "_tag": "Union",
          "checks": [],
          "types": [
            {
              "_tag": "Declaration",
              "representation": {
                "id": "effect/schema/Json",
                "payload": null
              },
              "annotations": {
                "expected": "JSON value"
              },
              "typeParameters": [],
              "checks": []
            },
            {
              "_tag": "Declaration",
              "representation": {
                "id": "effect/schema/Json",
                "payload": null
              },
              "annotations": {
                "expected": "JSON value"
              },
              "typeParameters": [],
              "checks": []
            }
          ],
          "mode": "anyOf"
        },
        "references": {}
      }
    )
  })

  it("imports built-in JSON Schema annotations", () => {
    assertFromJsonSchema(
      {
        schema: {
          type: "string",
          format: "email",
          contentEncoding: "base64",
          contentMediaType: "application/json",
          contentSchema: { type: "number" }
        }
      },
      {
        "representation": {
          "_tag": "String",
          "annotations": {
            "format": "email",
            "contentEncoding": "base64",
            "contentMediaType": "application/json",
            "contentSchema": { "type": "number" }
          },
          "checks": []
        },
        "references": {}
      }
    )
  })

  describe("$ref", () => {
    it("treats a reference with an empty token as unconstrained", () => {
      assertFromJsonSchema(
        { schema: { $ref: "" } },
        {
          "representation": {
            "_tag": "Declaration",
            "representation": {
              "id": "effect/schema/Json",
              "payload": null
            },
            "annotations": {
              "expected": "JSON value"
            },
            "typeParameters": [],
            "checks": []
          },
          "references": {}
        }
      )
    })

    it("should create a Reference and a definition", () => {
      assertFromJsonSchema(
        {
          schema: {
            $ref: "#/$defs/A",
            $defs: {
              A: {
                type: "string"
              }
            }
          }
        },
        {
          "representation": {
            "_tag": "Reference",
            "$ref": "A"
          },
          "references": {
            "A": {
              "_tag": "String",
              "annotations": {
                "identifier": "A"
              },
              "checks": []
            }
          }
        }
      )
    })

    it("should preserve an annotated $ref as a stable suspend", () => {
      assertFromJsonSchema(
        {
          schema: {
            $ref: "#/$defs/A",
            description: "a",
            $defs: {
              A: {
                type: "string"
              }
            }
          }
        },
        {
          "representation": {
            "_tag": "Suspend",
            "annotations": {
              "description": "a"
            },
            "checks": [],
            "thunk": {
              "_tag": "Reference",
              "$ref": "A"
            }
          },
          "references": {
            "A": {
              "_tag": "String",
              "annotations": {
                "identifier": "A"
              },
              "checks": []
            }
          }
        }
      )
    })

    it("does not combine annotation siblings with a $ref", () => {
      const schema = toSchemaFromJsonSchemaDocument(
        JsonSchema.fromSchemaDraft2020_12({
          $ref: "#/$defs/A",
          format: "custom",
          $defs: {
            A: { type: "number" }
          }
        })
      )
      const is = Schema.is(schema)
      assertTrue(is(1))
      assertFalse(is("a"))

      const document = SchemaRepresentation.toRepresentation(schema.ast)
      strictEqual(document.representation._tag, "Suspend")
      if (document.representation._tag === "Suspend") {
        deepStrictEqual(document.representation.annotations, { format: "custom" })
        deepStrictEqual(document.representation.thunk, { _tag: "Reference", $ref: "A" })
      }
    })

    it("should preserve a $ref refined only by annotations as a stable suspend", () => {
      assertFromJsonSchema(
        {
          schema: {
            allOf: [
              { $ref: "#/$defs/A" },
              { description: "a" }
            ],
            $defs: {
              A: {
                type: "string"
              }
            }
          }
        },
        {
          "representation": {
            "_tag": "Suspend",
            "annotations": {
              "description": "a"
            },
            "checks": [],
            "thunk": {
              "_tag": "Reference",
              "$ref": "A"
            }
          },
          "references": {
            "A": {
              "_tag": "String",
              "annotations": {
                "identifier": "A"
              },
              "checks": []
            }
          }
        }
      )
    })

    it("recursive schema", () => {
      assertFromJsonSchema(
        {
          schema: {
            $ref: "#/$defs/A",
            $defs: {
              A: {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string"
                  },
                  "children": {
                    "type": "array",
                    "items": {
                      "$ref": "#/$defs/A"
                    }
                  }
                },
                "required": [
                  "name",
                  "children"
                ],
                "additionalProperties": false
              }
            }
          }
        },
        {
          "representation": {
            "_tag": "Reference",
            "$ref": "A"
          },
          "references": {
            "A": {
              "_tag": "Objects",
              "annotations": {
                "identifier": "A"
              },
              "checks": [],
              "propertySignatures": [
                {
                  "name": {
                    "type": "string",
                    "value": "name"
                  },
                  "type": {
                    "_tag": "String",
                    "checks": []
                  },
                  "isOptional": false,
                  "isMutable": false
                },
                {
                  "name": {
                    "type": "string",
                    "value": "children"
                  },
                  "type": {
                    "_tag": "Arrays",
                    "checks": [],
                    "elements": [],
                    "rest": [
                      {
                        "_tag": "Suspend",
                        "checks": [],
                        "thunk": {
                          "_tag": "Reference",
                          "$ref": "A"
                        }
                      }
                    ]
                  },
                  "isOptional": false,
                  "isMutable": false
                }
              ],
              "indexSignatures": []
            }
          }
        }
      )
    })

    it("preserves annotations on a recursive $ref", () => {
      assertFromJsonSchema(
        {
          schema: {
            $ref: "#/$defs/Node",
            $defs: {
              Node: {
                type: "object",
                properties: {
                  child: {
                    $ref: "#/$defs/Node",
                    description: "recursive child"
                  }
                },
                required: ["child"],
                additionalProperties: false
              }
            }
          }
        },
        {
          representation: {
            _tag: "Reference",
            $ref: "Node"
          },
          references: {
            Node: {
              _tag: "Objects",
              annotations: {
                identifier: "Node"
              },
              checks: [],
              propertySignatures: [{
                name: { type: "string", value: "child" },
                type: {
                  _tag: "Suspend",
                  annotations: {
                    description: "recursive child"
                  },
                  checks: [],
                  thunk: {
                    _tag: "Reference",
                    $ref: "Node"
                  }
                },
                isOptional: false,
                isMutable: false
              }],
              indexSignatures: []
            }
          }
        }
      )
    })

    it("combines assertion siblings with a $ref", () => {
      const schema = toSchemaFromJsonSchemaDocument(
        JsonSchema.fromSchemaDraft2020_12({
          $ref: "#/$defs/Name",
          minLength: 2,
          description: "name",
          $defs: {
            Name: { type: "string" }
          }
        })
      )
      const is = Schema.is(schema)
      assertTrue(is("ab"))
      assertFalse(is("a"))

      const document = SchemaRepresentation.toRepresentation(schema.ast)
      strictEqual(document.representation._tag, "String")
      if (document.representation._tag === "String") {
        deepStrictEqual(document.representation.annotations, { description: "name" })
      }
      deepStrictEqual(document.references, {})
    })

    it("rejects assertion siblings on a recursive $ref", () => {
      throws(
        () =>
          SchemaRepresentation.fromJsonSchemaDocument(
            JsonSchema.fromSchemaDraft2020_12({
              $ref: "#/$defs/Node",
              $defs: {
                Node: {
                  type: "object",
                  properties: {
                    child: {
                      $ref: "#/$defs/Node",
                      minProperties: 1
                    }
                  }
                }
              }
            })
          ),
        `Unsupported assertion siblings on recursive reference Node\n  at ["definitions"]["Node"]["properties"]["child"]["$ref"]`
      )
    })
  })

  describe("allOf", () => {
    it("resolves references on either side of an intersection", () => {
      const definition: JsonSchema.JsonSchema = { type: "string", minLength: 1 }
      for (
        const schema of [
          {
            $ref: "#/$defs/A",
            allOf: [{ type: "string", maxLength: 2 }],
            $defs: { A: definition }
          },
          {
            allOf: [{ $ref: "#/$defs/A" }, { type: "string", maxLength: 2 }],
            $defs: { A: definition }
          }
        ]
      ) {
        assertFromJsonSchema({ schema }, {
          "representation": {
            "_tag": "String",
            "checks": [
              {
                "_tag": "Filter",
                "representation": {
                  "id": "effect/schema/isMinLength",
                  "payload": {
                    "minLength": 1
                  }
                },
                "annotations": {
                  "expected": "a value with a length of at least 1",
                  "~structural": true,
                  "arbitrary": {
                    "constraint": {
                      "minLength": 1
                    }
                  }
                },
                "aborted": false
              },
              {
                "_tag": "Filter",
                "representation": {
                  "id": "effect/schema/isMaxLength",
                  "payload": {
                    "maxLength": 2
                  }
                },
                "annotations": {
                  "expected": "a value with a length of at most 2",
                  "~structural": true,
                  "arbitrary": {
                    "constraint": {
                      "maxLength": 2
                    }
                  }
                },
                "aborted": false
              }
            ]
          },
          "references": {}
        })
      }
    })

    it("preserves annotations on array and object intersections", () => {
      assertFromJsonSchema(
        {
          schema: {
            type: "array",
            allOf: [{ description: "a" }]
          }
        },
        {
          "representation": {
            "_tag": "Arrays",
            "annotations": {
              "description": "a"
            },
            "checks": [],
            "elements": [],
            "rest": [
              {
                "_tag": "Declaration",
                "representation": {
                  "id": "effect/schema/Json",
                  "payload": null
                },
                "annotations": {
                  "expected": "JSON value"
                },
                "typeParameters": [],
                "checks": []
              }
            ]
          },
          "references": {}
        }
      )
      assertFromJsonSchema(
        {
          schema: {
            type: "object",
            additionalProperties: false,
            allOf: [{ description: "a" }]
          }
        },
        {
          "representation": {
            "_tag": "Objects",
            "annotations": {
              "description": "a"
            },
            "checks": [],
            "propertySignatures": [],
            "indexSignatures": []
          },
          "references": {}
        }
      )
    })

    it("returns Never when a union has no compatible member", () => {
      assertFromJsonSchema(
        {
          schema: {
            type: "string",
            allOf: [{ anyOf: [{ type: "number" }, { type: "boolean" }] }]
          }
        },
        {
          "representation": {
            "_tag": "Never",
            "checks": []
          },
          "references": {}
        }
      )
    })

    function assertLiteralRefinement(
      refinement: JsonSchema.JsonSchema,
      valid: string | number,
      invalid: string | number
    ) {
      for (const literal of [valid, invalid]) {
        for (const allOf of [[refinement, { const: literal }], [{ const: literal }, refinement]]) {
          const schema = toSchemaFromJsonSchemaDocument(
            JsonSchema.fromSchemaDraft2020_12({ allOf })
          )
          const is = Schema.is(schema)
          if (literal === valid) {
            assertTrue(is(literal))
          } else {
            assertFalse(is(literal))
          }
        }
      }
    }

    describe("literal refinements", () => {
      it("minLength", () => {
        assertLiteralRefinement({ type: "string", minLength: 2 }, "ab", "a")
      })

      it("maxLength", () => {
        assertLiteralRefinement({ type: "string", maxLength: 1 }, "a", "ab")
      })

      it("pattern", () => {
        assertLiteralRefinement({ type: "string", pattern: "^a+$" }, "aa", "ab")
      })

      it("integer", () => {
        assertLiteralRefinement({ type: "integer" }, 1, 1.5)
      })

      it("multipleOf", () => {
        assertLiteralRefinement({ type: "number", multipleOf: 0.1 }, 0.3, 0.31)
      })

      it("multipleOf beyond the toFixed precision limit", () => {
        assertLiteralRefinement({ type: "number", multipleOf: Number("1e-101") }, 0, Number("5e-102"))
      })

      it("multipleOf with a large scientific operand", () => {
        assertLiteralRefinement({ type: "number", multipleOf: 2 }, Number("1e21"), 1)
      })

      it("multipleOf with a nonzero subnormal remainder", () => {
        assertLiteralRefinement({ type: "number", multipleOf: Number("1e-323") }, 0, Number("1.042e-321"))
      })

      it("minimum", () => {
        assertLiteralRefinement({ type: "number", minimum: 1 }, 1, 0)
      })

      it("maximum", () => {
        assertLiteralRefinement({ type: "number", maximum: 1 }, 1, 2)
      })

      it("exclusiveMinimum", () => {
        assertLiteralRefinement({ type: "number", exclusiveMinimum: 1 }, 2, 1)
      })

      it("exclusiveMaximum", () => {
        assertLiteralRefinement({ type: "number", exclusiveMaximum: 1 }, 0, 1)
      })

      it("filter group", () => {
        assertLiteralRefinement(
          { type: "number", allOf: [{ minimum: 1, maximum: 2, description: "range" }] },
          2,
          0
        )
      })

      it("filters enum members", () => {
        for (
          const [schema, member] of [
            [{ type: "string", minLength: 2 }, { enum: ["a", "ab"] }],
            [{ enum: ["a", "ab"] }, { type: "string", minLength: 2 }]
          ]
        ) {
          assertFromJsonSchema(
            { schema: { ...schema, allOf: [member] } },
            {
              "representation": {
                "_tag": "Union",
                "checks": [],
                "types": [
                  {
                    "_tag": "Literal",
                    "checks": [],
                    "literal": {
                      "type": "string",
                      "value": "ab"
                    }
                  }
                ],
                "mode": "anyOf"
              },
              "references": {}
            }
          )
        }
      })
    })

    it("no type", () => {
      assertFromJsonSchema(
        {
          schema: {
            allOf: [
              { type: "string" }
            ]
          }
        },
        {
          "representation": {
            "_tag": "String",
            "checks": []
          },
          "references": {}
        }
      )
    })

    describe("type: string", () => {
      it("& minLength", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { minLength: 1 }
              ]
            }
          },
          {
            "representation": {
              "_tag": "String",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMinLength",
                    "payload": {
                      "minLength": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at least 1",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "minLength": 1
                      }
                    }
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("& minLength + description", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { minLength: 1, description: "b" }
              ]
            }
          },
          {
            "representation": {
              "_tag": "String",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMinLength",
                    "payload": {
                      "minLength": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at least 1",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "minLength": 1
                      }
                    },
                    "description": "b"
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("description & minLength", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              description: "a",
              allOf: [
                { minLength: 1 }
              ]
            }
          },
          {
            "representation": {
              "_tag": "String",
              "annotations": {
                "description": "a"
              },
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMinLength",
                    "payload": {
                      "minLength": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at least 1",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "minLength": 1
                      }
                    }
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("description & description", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              description: "a",
              allOf: [
                { description: "b" }
              ]
            }
          },
          {
            "representation": {
              "_tag": "String",
              "annotations": {
                "description": "b"
              },
              "checks": []
            },
            "references": {}
          }
        )
      })

      it("description & minLength + description", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              description: "a",
              allOf: [
                { minLength: 1, description: "b" }
              ]
            }
          },
          {
            "representation": {
              "_tag": "String",
              "annotations": {
                "description": "a"
              },
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMinLength",
                    "payload": {
                      "minLength": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at least 1",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "minLength": 1
                      }
                    },
                    "description": "b"
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("maxLength & minLength", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              maxLength: 2,
              allOf: [
                { minLength: 1 }
              ]
            }
          },
          {
            "representation": {
              "_tag": "String",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMaxLength",
                    "payload": {
                      "maxLength": 2
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at most 2",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "maxLength": 2
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMinLength",
                    "payload": {
                      "minLength": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at least 1",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "minLength": 1
                      }
                    }
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("description + maxLength & minLength", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              description: "a",
              maxLength: 2,
              allOf: [
                { minLength: 1 }
              ]
            }
          },
          {
            "representation": {
              "_tag": "String",
              "annotations": {
                "description": "a"
              },
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMaxLength",
                    "payload": {
                      "maxLength": 2
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at most 2",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "maxLength": 2
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMinLength",
                    "payload": {
                      "minLength": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at least 1",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "minLength": 1
                      }
                    }
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("description + maxLength & minLength + description", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              description: "a",
              maxLength: 2,
              allOf: [
                { minLength: 1, description: "b" }
              ]
            }
          },
          {
            "representation": {
              "_tag": "String",
              "annotations": {
                "description": "a"
              },
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMaxLength",
                    "payload": {
                      "maxLength": 2
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at most 2",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "maxLength": 2
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMinLength",
                    "payload": {
                      "minLength": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at least 1",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "minLength": 1
                      }
                    },
                    "description": "b"
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("& minLength + maxLength", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { minLength: 1, maxLength: 2 }
              ]
            }
          },
          {
            "representation": {
              "_tag": "String",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMinLength",
                    "payload": {
                      "minLength": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at least 1",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "minLength": 1
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMaxLength",
                    "payload": {
                      "maxLength": 2
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at most 2",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "maxLength": 2
                      }
                    }
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("& minLength + maxLength + description", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { minLength: 1, maxLength: 2, description: "b" }
              ]
            }
          },
          {
            "representation": {
              "_tag": "String",
              "checks": [
                {
                  "_tag": "FilterGroup",
                  "annotations": {
                    "description": "b"
                  },
                  "checks": [
                    {
                      "_tag": "Filter",
                      "representation": {
                        "id": "effect/schema/isMinLength",
                        "payload": {
                          "minLength": 1
                        }
                      },
                      "annotations": {
                        "expected": "a value with a length of at least 1",
                        "~structural": true,
                        "arbitrary": {
                          "constraint": {
                            "minLength": 1
                          }
                        }
                      },
                      "aborted": false
                    },
                    {
                      "_tag": "Filter",
                      "representation": {
                        "id": "effect/schema/isMaxLength",
                        "payload": {
                          "maxLength": 2
                        }
                      },
                      "annotations": {
                        "expected": "a value with a length of at most 2",
                        "~structural": true,
                        "arbitrary": {
                          "constraint": {
                            "maxLength": 2
                          }
                        }
                      },
                      "aborted": false
                    }
                  ]
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("& (minLength & maxLength + description)", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { minLength: 1, allOf: [{ maxLength: 2, description: "c" }] }
              ]
            }
          },
          {
            "representation": {
              "_tag": "String",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMinLength",
                    "payload": {
                      "minLength": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at least 1",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "minLength": 1
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMaxLength",
                    "payload": {
                      "maxLength": 2
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at most 2",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "maxLength": 2
                      }
                    },
                    "description": "c"
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("& (minLength + description & maxLength + description)", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { minLength: 1, description: "b", allOf: [{ maxLength: 2, description: "c" }] }
              ]
            }
          },
          {
            "representation": {
              "_tag": "String",
              "checks": [
                {
                  "_tag": "FilterGroup",
                  "annotations": {
                    "description": "b"
                  },
                  "checks": [
                    {
                      "_tag": "Filter",
                      "representation": {
                        "id": "effect/schema/isMinLength",
                        "payload": {
                          "minLength": 1
                        }
                      },
                      "annotations": {
                        "expected": "a value with a length of at least 1",
                        "~structural": true,
                        "arbitrary": {
                          "constraint": {
                            "minLength": 1
                          }
                        }
                      },
                      "aborted": false
                    },
                    {
                      "_tag": "Filter",
                      "representation": {
                        "id": "effect/schema/isMaxLength",
                        "payload": {
                          "maxLength": 2
                        }
                      },
                      "annotations": {
                        "expected": "a value with a length of at most 2",
                        "~structural": true,
                        "arbitrary": {
                          "constraint": {
                            "maxLength": 2
                          }
                        },
                        "description": "c"
                      },
                      "aborted": false
                    }
                  ]
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("& string enum", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { enum: ["a"] }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Literal",
              "checks": [],
              "literal": {
                "type": "string",
                "value": "a"
              }
            },
            "references": {}
          }
        )
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              description: "a",
              allOf: [
                { enum: ["a"], description: "b" }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Literal",
              "annotations": {
                "description": "b"
              },
              "checks": [],
              "literal": {
                "type": "string",
                "value": "a"
              }
            },
            "references": {}
          }
        )
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { enum: ["a", "b"] }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Union",
              "checks": [],
              "types": [
                {
                  "_tag": "Literal",
                  "checks": [],
                  "literal": {
                    "type": "string",
                    "value": "a"
                  }
                },
                {
                  "_tag": "Literal",
                  "checks": [],
                  "literal": {
                    "type": "string",
                    "value": "b"
                  }
                }
              ],
              "mode": "anyOf"
            },
            "references": {}
          }
        )
      })

      it("& mixed enum", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "string",
              allOf: [
                { enum: ["a", 1] }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Union",
              "checks": [],
              "types": [
                {
                  "_tag": "Literal",
                  "checks": [],
                  "literal": {
                    "type": "string",
                    "value": "a"
                  }
                }
              ],
              "mode": "anyOf"
            },
            "references": {}
          }
        )
      })
    })

    describe("type: number", () => {
      it("number & number preserves annotations after removing duplicate checks", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "number",
              allOf: [{ type: "number", description: "b" }]
            }
          },
          {
            "representation": {
              "_tag": "Number",
              "annotations": {
                "description": "b"
              },
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isFinite",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "a finite number",
                    "arbitrary": {
                      "constraint": {
                        "noInfinity": true,
                        "noNaN": true
                      }
                    }
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("number & integer", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "number",
              allOf: [
                { type: "integer" }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Number",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isFinite",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "a finite number",
                    "arbitrary": {
                      "constraint": {
                        "noInfinity": true,
                        "noNaN": true
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isInt",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "an integer",
                    "arbitrary": {
                      "constraint": {
                        "integer": true
                      }
                    }
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("number & integer & integer", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "number",
              allOf: [
                { type: "integer", minimum: 2 },
                { type: "integer", maximum: 2 }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Number",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isFinite",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "a finite number",
                    "arbitrary": {
                      "constraint": {
                        "noInfinity": true,
                        "noNaN": true
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isInt",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "an integer",
                    "arbitrary": {
                      "constraint": {
                        "integer": true
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isGreaterThanOrEqualTo",
                    "payload": {
                      "minimum": 2
                    }
                  },
                  "annotations": {
                    "expected": "a value greater than or equal to 2"
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isLessThanOrEqualTo",
                    "payload": {
                      "maximum": 2
                    }
                  },
                  "annotations": {
                    "expected": "a value less than or equal to 2"
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("integer & number", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "integer",
              allOf: [
                { type: "number" }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Number",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isInt",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "an integer",
                    "arbitrary": {
                      "constraint": {
                        "integer": true
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isFinite",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "a finite number",
                    "arbitrary": {
                      "constraint": {
                        "noInfinity": true,
                        "noNaN": true
                      }
                    }
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("& (minimum + description & maximum + description)", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "number",
              allOf: [
                { minimum: 1, description: "b", allOf: [{ maximum: 2, description: "c" }] }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Number",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isFinite",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "a finite number",
                    "arbitrary": {
                      "constraint": {
                        "noInfinity": true,
                        "noNaN": true
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "FilterGroup",
                  "annotations": {
                    "description": "b"
                  },
                  "checks": [
                    {
                      "_tag": "Filter",
                      "representation": {
                        "id": "effect/schema/isGreaterThanOrEqualTo",
                        "payload": {
                          "minimum": 1
                        }
                      },
                      "annotations": {
                        "expected": "a value greater than or equal to 1"
                      },
                      "aborted": false
                    },
                    {
                      "_tag": "Filter",
                      "representation": {
                        "id": "effect/schema/isLessThanOrEqualTo",
                        "payload": {
                          "maximum": 2
                        }
                      },
                      "annotations": {
                        "expected": "a value less than or equal to 2",
                        "description": "c"
                      },
                      "aborted": false
                    }
                  ]
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("continues intersecting after an annotated filter group", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "number",
              allOf: [
                { minimum: 1, maximum: 2, description: "range" },
                { type: "integer" }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Number",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isFinite",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "a finite number",
                    "arbitrary": {
                      "constraint": {
                        "noInfinity": true,
                        "noNaN": true
                      }
                    }
                  },
                  "aborted": false
                },
                {
                  "_tag": "FilterGroup",
                  "annotations": {
                    "description": "range"
                  },
                  "checks": [
                    {
                      "_tag": "Filter",
                      "representation": {
                        "id": "effect/schema/isGreaterThanOrEqualTo",
                        "payload": {
                          "minimum": 1
                        }
                      },
                      "annotations": {
                        "expected": "a value greater than or equal to 1"
                      },
                      "aborted": false
                    },
                    {
                      "_tag": "Filter",
                      "representation": {
                        "id": "effect/schema/isLessThanOrEqualTo",
                        "payload": {
                          "maximum": 2
                        }
                      },
                      "annotations": {
                        "expected": "a value less than or equal to 2"
                      },
                      "aborted": false
                    }
                  ]
                },
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isInt",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "an integer",
                    "arbitrary": {
                      "constraint": {
                        "integer": true
                      }
                    }
                  },
                  "aborted": false
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("& number enum", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "number",
              allOf: [
                { enum: [1] }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Literal",
              "checks": [],
              "literal": {
                "type": "number",
                "value": 1
              }
            },
            "references": {}
          }
        )
        assertFromJsonSchema(
          {
            schema: {
              type: "number",
              description: "a",
              allOf: [
                { enum: [1], description: "b" }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Literal",
              "annotations": {
                "description": "b"
              },
              "checks": [],
              "literal": {
                "type": "number",
                "value": 1
              }
            },
            "references": {}
          }
        )
        assertFromJsonSchema(
          {
            schema: {
              type: "number",
              allOf: [
                { enum: [1, 2] }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Union",
              "checks": [],
              "types": [
                {
                  "_tag": "Literal",
                  "checks": [],
                  "literal": {
                    "type": "number",
                    "value": 1
                  }
                },
                {
                  "_tag": "Literal",
                  "checks": [],
                  "literal": {
                    "type": "number",
                    "value": 2
                  }
                }
              ],
              "mode": "anyOf"
            },
            "references": {}
          }
        )
      })
    })

    describe("type: boolean", () => {
      it("boolean & boolean", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "boolean",
              allOf: [{ type: "boolean" }]
            }
          },
          {
            "representation": {
              "_tag": "Boolean",
              "checks": []
            },
            "references": {}
          }
        )
      })

      it("boolean & non-boolean literal", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "boolean",
              allOf: [{ const: 1 }]
            }
          },
          {
            "representation": {
              "_tag": "Never",
              "checks": []
            },
            "references": {}
          }
        )
      })

      it("& boolean enum", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "boolean",
              allOf: [
                { enum: [true] }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Literal",
              "checks": [],
              "literal": {
                "type": "boolean",
                "value": true
              }
            },
            "references": {}
          }
        )
        assertFromJsonSchema(
          {
            schema: {
              type: "boolean",
              description: "a",
              allOf: [
                { enum: [true], description: "b" }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Literal",
              "annotations": {
                "description": "b"
              },
              "checks": [],
              "literal": {
                "type": "boolean",
                "value": true
              }
            },
            "references": {}
          }
        )
      })
    })

    describe("type: array", () => {
      function assertArrayAllOf(
        a: JsonSchema.JsonSchema,
        b: JsonSchema.JsonSchema,
        expected: Parameters<typeof assertFromJsonSchema>[1],
        valid: ReadonlyArray<unknown>,
        invalid: ReadonlyArray<unknown>
      ) {
        for (const [schema, member] of [[a, b], [b, a]]) {
          const document = assertFromJsonSchema(
            { schema: { ...schema, allOf: [member] } },
            expected
          )
          const is = Schema.is(document)
          for (const value of valid) {
            assertTrue(is(value))
          }
          for (const value of invalid) {
            assertFalse(is(value))
          }
        }
      }

      it("uniqueItems & uniqueItems", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "array",
              uniqueItems: true,
              allOf: [
                { uniqueItems: true }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Arrays",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isUnique",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "an array with unique items",
                    "arbitrary": {
                      "constraint": {
                        "unique": true
                      }
                    }
                  },
                  "aborted": false
                }
              ],
              "elements": [],
              "rest": [
                {
                  "_tag": "Declaration",
                  "representation": {
                    "id": "effect/schema/Json",
                    "payload": null
                  },
                  "annotations": {
                    "expected": "JSON value"
                  },
                  "typeParameters": [],
                  "checks": []
                }
              ]
            },
            "references": {}
          }
        )
      })

      it("combines unequal open prefixes", () => {
        assertArrayAllOf(
          {
            type: "array",
            prefixItems: [{ type: "string" }],
            minItems: 1,
            items: { type: "string" }
          },
          {
            type: "array",
            prefixItems: [{ type: "string" }, { const: "tail" }],
            minItems: 2,
            items: { type: "string" }
          },
          {
            "representation": {
              "_tag": "Arrays",
              "checks": [],
              "elements": [
                {
                  "isOptional": false,
                  "type": {
                    "_tag": "String",
                    "checks": []
                  }
                },
                {
                  "isOptional": false,
                  "type": {
                    "_tag": "Literal",
                    "checks": [],
                    "literal": {
                      "type": "string",
                      "value": "tail"
                    }
                  }
                }
              ],
              "rest": [
                {
                  "_tag": "String",
                  "checks": []
                }
              ]
            },
            "references": {}
          },
          [["head", "tail"], ["head", "tail", "more"]],
          [["head"], ["head", "other"], ["head", "tail", 1]]
        )
      })

      it("truncates optional elements forbidden by a closed tuple", () => {
        assertArrayAllOf(
          {
            type: "array",
            prefixItems: [{ type: "string" }],
            minItems: 1,
            maxItems: 1
          },
          {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "number" }],
            minItems: 1,
            maxItems: 2
          },
          {
            "representation": {
              "_tag": "Arrays",
              "checks": [],
              "elements": [
                {
                  "isOptional": false,
                  "type": {
                    "_tag": "String",
                    "checks": []
                  }
                }
              ],
              "rest": []
            },
            "references": {}
          },
          [["head"]],
          [[], ["head", 1]]
        )
      })

      it("returns Never when a closed tuple forbids a required element", () => {
        assertArrayAllOf(
          {
            type: "array",
            prefixItems: [{ type: "string" }],
            minItems: 1,
            maxItems: 1
          },
          {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "number" }],
            minItems: 2,
            maxItems: 2
          },
          {
            "representation": {
              "_tag": "Never",
              "checks": []
            },
            "references": {}
          },
          [],
          [[], ["head"], ["head", 1]]
        )
      })

      it("combines an open rest with a closed rest", () => {
        assertArrayAllOf(
          {
            type: "array",
            prefixItems: [{ type: "string" }],
            minItems: 1,
            items: { type: "number" }
          },
          {
            type: "array",
            prefixItems: [{ type: "string" }],
            minItems: 1,
            maxItems: 1
          },
          {
            "representation": {
              "_tag": "Arrays",
              "checks": [],
              "elements": [
                {
                  "isOptional": false,
                  "type": {
                    "_tag": "String",
                    "checks": []
                  }
                }
              ],
              "rest": []
            },
            "references": {}
          },
          [["head"]],
          [[], ["head", 1]]
        )
      })

      it("closes the tuple when the rest intersection is Never", () => {
        assertArrayAllOf(
          {
            type: "array",
            prefixItems: [{ type: "string" }],
            minItems: 1,
            items: { type: "string" }
          },
          {
            type: "array",
            prefixItems: [{ type: "string" }],
            minItems: 1,
            items: { type: "number" }
          },
          {
            "representation": {
              "_tag": "Arrays",
              "checks": [],
              "elements": [
                {
                  "isOptional": false,
                  "type": {
                    "_tag": "String",
                    "checks": []
                  }
                }
              ],
              "rest": []
            },
            "references": {}
          },
          [["head"]],
          [[], ["head", "tail"], ["head", 1]]
        )
      })

      it("rejects a required literal that fails rest refinements", () => {
        assertArrayAllOf(
          {
            type: "array",
            minItems: 1,
            items: { const: 0 }
          },
          {
            type: "array",
            prefixItems: [{ type: "number", minimum: 1 }],
            minItems: 1,
            maxItems: 1
          },
          {
            "representation": {
              "_tag": "Never",
              "checks": []
            },
            "references": {}
          },
          [],
          [[], [0]]
        )
      })

      it("truncates an optional literal that fails rest refinements", () => {
        assertArrayAllOf(
          {
            type: "array",
            items: { const: 0 }
          },
          {
            type: "array",
            prefixItems: [{ type: "number", minimum: 1 }],
            maxItems: 1
          },
          {
            "representation": {
              "_tag": "Arrays",
              "checks": [],
              "elements": [],
              "rest": []
            },
            "references": {}
          },
          [[]],
          [[0]]
        )
      })

      it("preserves a literal that satisfies rest refinements", () => {
        assertArrayAllOf(
          {
            type: "array",
            minItems: 1,
            items: { const: 2 }
          },
          {
            type: "array",
            prefixItems: [{ type: "number", minimum: 1 }],
            minItems: 1,
            maxItems: 1
          },
          {
            "representation": {
              "_tag": "Arrays",
              "checks": [
                {
                  "_tag": "Filter",
                  "representation": {
                    "id": "effect/schema/isMinLength",
                    "payload": {
                      "minLength": 1
                    }
                  },
                  "annotations": {
                    "expected": "a value with a length of at least 1",
                    "~structural": true,
                    "arbitrary": {
                      "constraint": {
                        "minLength": 1
                      }
                    }
                  },
                  "aborted": false
                }
              ],
              "elements": [
                {
                  "isOptional": false,
                  "type": {
                    "_tag": "Literal",
                    "checks": [],
                    "literal": {
                      "type": "number",
                      "value": 2
                    }
                  }
                }
              ],
              "rest": []
            },
            "references": {}
          },
          [[2]],
          [[], [0]]
        )
      })
    })

    it("short-circuits Never and handles primitive intersections", () => {
      for (
        const schema of [
          { allOf: [false, { type: "string" }] },
          { allOf: [{ type: "array" }, { type: "string" }] },
          { allOf: [{ type: "object" }, { type: "string" }] },
          { allOf: [{ type: "null" }, { type: "string" }] },
          { allOf: [{ const: 1 }, { const: 2 }] }
        ]
      ) {
        assertFromJsonSchema({ schema }, {
          "representation": {
            "_tag": "Never",
            "checks": []
          },
          "references": {}
        })
      }

      assertFromJsonSchema(
        { schema: { allOf: [{ type: "null" }, { type: "null" }] } },
        {
          "representation": {
            "_tag": "Null",
            "checks": []
          },
          "references": {}
        }
      )
      assertFromJsonSchema(
        { schema: { allOf: [{ const: 1 }, { const: 1 }] } },
        {
          "representation": {
            "_tag": "Literal",
            "checks": [],
            "literal": {
              "type": "number",
              "value": 1
            }
          },
          "references": {}
        }
      )
      for (
        const allOf of [
          [{ type: "boolean" }, { const: true }],
          [{ const: true }, { type: "boolean" }]
        ]
      ) {
        assertFromJsonSchema(
          { schema: { allOf } },
          {
            "representation": {
              "_tag": "Literal",
              "checks": [],
              "literal": {
                "type": "boolean",
                "value": true
              }
            },
            "references": {}
          }
        )
      }
    })

    it("combines references and annotated stable wrappers on either side", () => {
      const definition: JsonSchema.JsonSchema = { type: "string", minLength: 1 }
      assertFromJsonSchema(
        {
          schema: {
            type: "string",
            allOf: [{ $ref: "#/$defs/A" }],
            $defs: { A: definition }
          }
        },
        {
          "representation": {
            "_tag": "String",
            "checks": [
              {
                "_tag": "Filter",
                "representation": {
                  "id": "effect/schema/isMinLength",
                  "payload": {
                    "minLength": 1
                  }
                },
                "annotations": {
                  "expected": "a value with a length of at least 1",
                  "~structural": true,
                  "arbitrary": {
                    "constraint": {
                      "minLength": 1
                    }
                  }
                },
                "aborted": false
              }
            ]
          },
          "references": {}
        }
      )

      for (
        const schema of [
          {
            type: "string",
            allOf: [{ $ref: "#/$defs/A", description: "annotated" }],
            $defs: { A: definition }
          },
          {
            $ref: "#/$defs/A",
            description: "annotated",
            allOf: [{ type: "string" }],
            $defs: { A: definition }
          }
        ]
      ) {
        const document = fromJsonSchemaRepresentation(JsonSchema.fromSchemaDraft2020_12(schema))
        strictEqual(document.representation._tag, "String")
        if (document.representation._tag === "String") {
          strictEqual(document.representation.annotations?.description, "annotated")
        }
      }

      const aliases = fromJsonSchemaRepresentation(
        JsonSchema.fromSchemaDraft2020_12({
          type: "string",
          allOf: [{ $ref: "#/$defs/A" }],
          $defs: {
            A: { $ref: "#/$defs/B", description: "alias" },
            B: { type: "string" }
          }
        })
      )
      strictEqual(aliases.representation._tag, "String")
      if (aliases.representation._tag === "String") {
        strictEqual(aliases.representation.annotations?.description, "alias")
      }
    })

    it("merges string annotations, overlapping properties and index signatures", () => {
      const string = fromJsonSchemaRepresentation(
        JsonSchema.fromSchemaDraft2020_12({
          allOf: [
            { type: "string", contentMediaType: "application/json" },
            { type: "string", contentSchema: { type: "number" } }
          ]
        })
      )
      strictEqual(string.representation._tag, "String")
      if (string.representation._tag === "String") {
        deepStrictEqual(string.representation.annotations, {
          contentMediaType: "application/json",
          contentSchema: { type: "number" }
        })
      }

      const object = toSchemaFromJsonSchemaDocument(
        JsonSchema.fromSchemaDraft2020_12({
          type: "object",
          additionalProperties: false,
          properties: { a: { type: "string" } },
          required: ["a"],
          allOf: [{
            type: "object",
            additionalProperties: false,
            properties: { a: { type: "string", minLength: 2 } },
            required: ["a"]
          }]
        })
      )
      const isObject = Schema.is(object)
      assertTrue(isObject({ a: "ab" }))
      assertFalse(isObject({ a: "a" }))

      const optionalObject = fromJsonSchemaRepresentation(
        JsonSchema.fromSchemaDraft2020_12({
          type: "object",
          additionalProperties: false,
          properties: { a: { type: "string" } },
          allOf: [{
            type: "object",
            additionalProperties: false,
            properties: { a: { minLength: 1 } }
          }]
        })
      )
      strictEqual(optionalObject.representation._tag, "Objects")
      if (optionalObject.representation._tag === "Objects") {
        strictEqual(optionalObject.representation.propertySignatures[0].isOptional, true)
      }

      const indexes = fromJsonSchemaRepresentation(
        JsonSchema.fromSchemaDraft2020_12({
          type: "object",
          additionalProperties: false,
          patternProperties: { "^a": { type: "string" } },
          allOf: [
            { type: "object", additionalProperties: true },
            {
              type: "object",
              additionalProperties: false,
              patternProperties: { "^b": { type: "number" } }
            }
          ]
        })
      )
      strictEqual(indexes.representation._tag, "Objects")
      if (indexes.representation._tag === "Objects") {
        strictEqual(indexes.representation.indexSignatures.length, 3)
      }
    })

    describe("type: object", () => {
      it("add properties", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "object",
              additionalProperties: false,
              allOf: [
                { properties: { a: { type: "string" } } }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Objects",
              "checks": [],
              "propertySignatures": [
                {
                  "name": {
                    "type": "string",
                    "value": "a"
                  },
                  "type": {
                    "_tag": "String",
                    "checks": []
                  },
                  "isOptional": true,
                  "isMutable": false
                }
              ],
              "indexSignatures": []
            },
            "references": {}
          }
        )
      })

      it("add additionalProperties", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "object",
              allOf: [
                { additionalProperties: { type: "boolean" } }
              ]
            }
          },
          {
            "representation": {
              "_tag": "Objects",
              "checks": [],
              "propertySignatures": [],
              "indexSignatures": [
                {
                  "parameter": {
                    "_tag": "String",
                    "checks": []
                  },
                  "type": {
                    "_tag": "Boolean",
                    "checks": []
                  }
                }
              ]
            },
            "references": {}
          }
        )
      })
    })
  })

  describe("options", () => {
    describe("onEnter", () => {
      it("additionalProperties false via onEnter", () => {
        assertFromJsonSchema(
          {
            schema: {
              type: "object",
              properties: {
                a: { type: "string" }
              },
              required: ["a"]
            },
            options: {
              onEnter: (js) => {
                if (js.type === "object" && js.additionalProperties === undefined) {
                  return { ...js, additionalProperties: false }
                }
                return js
              }
            }
          },
          {
            "representation": {
              "_tag": "Objects",
              "checks": [],
              "propertySignatures": [
                {
                  "name": {
                    "type": "string",
                    "value": "a"
                  },
                  "type": {
                    "_tag": "String",
                    "checks": []
                  },
                  "isOptional": false,
                  "isMutable": false
                }
              ],
              "indexSignatures": []
            },
            "references": {}
          }
        )
      })

      it("strips annotation keys via onEnter", () => {
        assertFromJsonSchema(
          {
            schema: {
              title: "a",
              description: "b",
              examples: ["d"]
            },
            options: {
              onEnter: (js) => {
                const out = { ...js }
                delete out.examples
                return out
              }
            }
          },
          {
            "representation": {
              "_tag": "Declaration",
              "representation": {
                "id": "effect/schema/Json",
                "payload": null
              },
              "annotations": {
                "expected": "JSON value",
                "title": "a",
                "description": "b"
              },
              "typeParameters": [],
              "checks": []
            },
            "references": {}
          }
        )
      })

      it("filters annotations by predicate via onEnter", () => {
        assertFromJsonSchema(
          {
            schema: {
              title: "a",
              description: "b",
              examples: ["d"],
              default: "c"
            },
            options: {
              onEnter: (js) => {
                const out: any = {}
                for (const [k, v] of Object.entries(js)) {
                  if (k === "title" || k === "default" || k === "type") out[k] = v
                }
                return out
              }
            }
          },
          {
            "representation": {
              "_tag": "Declaration",
              "representation": {
                "id": "effect/schema/Json",
                "payload": null
              },
              "annotations": {
                "expected": "JSON value",
                "title": "a",
                "default": "c"
              },
              "typeParameters": [],
              "checks": []
            },
            "references": {}
          }
        )
      })

      it("default preserves all annotations", () => {
        assertFromJsonSchema(
          {
            schema: {
              title: "a",
              description: "b",
              default: "c",
              examples: ["d"]
            }
          },
          {
            "representation": {
              "_tag": "Declaration",
              "representation": {
                "id": "effect/schema/Json",
                "payload": null
              },
              "annotations": {
                "expected": "JSON value",
                "title": "a",
                "description": "b",
                "default": "c",
                "examples": [
                  "d"
                ]
              },
              "typeParameters": [],
              "checks": []
            },
            "references": {}
          }
        )
      })
    })
  })
})
