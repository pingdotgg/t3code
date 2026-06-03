import { describe, expect, test } from "vitest";

import {
  fromAttributeValue,
  isMapSchemaType,
  isNumberSetSchema,
  isStringSetSchema,
  toAttributeType,
  toAttributeValue,
} from "@/AWS/DynamoDB/AttributeValue";
import type { AttributeValue } from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";

describe("toAttributeValue", () => {
  test("undefined -> NULL false", async () => {
    const result = await Effect.runPromise(toAttributeValue(undefined));
    expect(result).toEqual({ NULL: false });
  });

  test("null -> NULL true", async () => {
    const result = await Effect.runPromise(toAttributeValue(null));
    expect(result).toEqual({ NULL: true });
  });

  test("boolean true -> BOOL", async () => {
    const result = await Effect.runPromise(toAttributeValue(true));
    expect(result).toEqual({ BOOL: true });
  });

  test("boolean false -> BOOL", async () => {
    const result = await Effect.runPromise(toAttributeValue(false));
    expect(result).toEqual({ BOOL: false });
  });

  test("string -> S", async () => {
    const result = await Effect.runPromise(toAttributeValue("hello"));
    expect(result).toEqual({ S: "hello" });
  });

  test("number -> N", async () => {
    const result = await Effect.runPromise(toAttributeValue(42));
    expect(result).toEqual({ N: "42" });
  });

  test("float number -> N", async () => {
    const result = await Effect.runPromise(toAttributeValue(3.14));
    expect(result).toEqual({ N: "3.14" });
  });

  test("array -> L", async () => {
    const result = await Effect.runPromise(toAttributeValue([1, 2, 3]));
    expect(result).toEqual({
      L: [{ N: "1" }, { N: "2" }, { N: "3" }],
    });
  });

  test("mixed array -> L", async () => {
    const result = await Effect.runPromise(
      toAttributeValue(["hello", 42, true]),
    );
    expect(result).toEqual({
      L: [{ S: "hello" }, { N: "42" }, { BOOL: true }],
    });
  });

  test("empty array -> L", async () => {
    const result = await Effect.runPromise(toAttributeValue([]));
    expect(result).toEqual({ L: [] });
  });

  test("object -> M", async () => {
    const result = await Effect.runPromise(
      toAttributeValue({ name: "Alice", age: 30 }),
    );
    expect(result).toEqual({
      M: {
        name: { S: "Alice" },
        age: { N: "30" },
      },
    });
  });

  test("nested object -> M", async () => {
    const result = await Effect.runPromise(
      toAttributeValue({
        user: {
          name: "Alice",
          details: {
            age: 30,
          },
        },
      }),
    );
    expect(result).toEqual({
      M: {
        user: {
          M: {
            name: { S: "Alice" },
            details: {
              M: {
                age: { N: "30" },
              },
            },
          },
        },
      },
    });
  });

  test("empty object -> M", async () => {
    const result = await Effect.runPromise(toAttributeValue({}));
    expect(result).toEqual({ M: {} });
  });

  test("Set of strings -> SS", async () => {
    const result = await Effect.runPromise(
      toAttributeValue(new Set(["a", "b", "c"])),
    );
    expect(result).toEqual({ SS: ["a", "b", "c"] });
  });

  test("Set of numbers -> NS", async () => {
    const result = await Effect.runPromise(
      toAttributeValue(new Set([1, 2, 3])),
    );
    // NS values are returned as-is (numbers in this case)
    expect(result.NS).toEqual(["1", "2", "3"]);
  });

  test("empty Set -> SS (empty)", async () => {
    const result = await Effect.runPromise(toAttributeValue(new Set()));
    expect(result).toEqual({ SS: [] });
  });

  test("Set of mixed types -> L", async () => {
    const result = await Effect.runPromise(
      toAttributeValue(new Set([1, "two", true])),
    );
    expect(result).toEqual({
      L: [{ N: "1" }, { S: "two" }, { BOOL: true }],
    });
  });

  test("Uint8Array -> B", async () => {
    const uint8 = new Uint8Array([1, 2, 3, 4]);
    const result = await Effect.runPromise(toAttributeValue(uint8));
    expect(result).toEqual({ B: uint8 });
  });

  test("Buffer -> B", async () => {
    const buffer = Buffer.from([1, 2, 3, 4]);
    const result = await Effect.runPromise(toAttributeValue(buffer));
    expect(result.B).toBeInstanceOf(Uint8Array);
  });

  test("File -> B", async () => {
    const file = new File(["hello"], "test.txt");
    const result = await Effect.runPromise(toAttributeValue(file));
    expect(result.B).toBeInstanceOf(Uint8Array);
  });

  test("ArrayBuffer -> B", async () => {
    const arrayBuffer = new ArrayBuffer(4);
    const result = await Effect.runPromise(toAttributeValue(arrayBuffer));
    expect(result.B).toBeInstanceOf(Uint8Array);
  });

  test("complex nested structure", async () => {
    const result = await Effect.runPromise(
      toAttributeValue({
        id: "123",
        name: "Alice",
        age: 30,
        active: true,
        tags: ["developer", "typescript"],
        metadata: {
          created: "2023-01-01",
          count: 42,
        },
        scores: new Set([100, 95, 88]),
      }),
    );
    expect(result).toEqual({
      M: {
        id: { S: "123" },
        name: { S: "Alice" },
        age: { N: "30" },
        active: { BOOL: true },
        tags: {
          L: [{ S: "developer" }, { S: "typescript" }],
        },
        metadata: {
          M: {
            created: { S: "2023-01-01" },
            count: { N: "42" },
          },
        },
        scores: { NS: expect.any(Array) },
      },
    });
  });

  test("invalid type throws error", async () => {
    const symbol = Symbol("test");
    const result = Effect.runPromise(
      toAttributeValue(symbol).pipe(
        Effect.map(() => false),
        Effect.catchTag("InvalidAttributeValue", (error) =>
          Effect.succeed(true),
        ),
      ),
    );
    await expect(result).resolves.toBe(true);
  });
});

describe("fromAttributeValue", () => {
  test("NULL true -> null", () => {
    expect(fromAttributeValue({ NULL: true })).toBe(null);
  });

  test("BOOL -> boolean", () => {
    expect(fromAttributeValue({ BOOL: true })).toBe(true);
    expect(fromAttributeValue({ BOOL: false })).toBe(false);
  });

  test("S -> string", () => {
    expect(fromAttributeValue({ S: "hello" })).toBe("hello");
  });

  test("N -> number", () => {
    expect(fromAttributeValue({ N: "42" })).toBe(42);
    expect(fromAttributeValue({ N: "3.14" })).toBe(3.14);
  });

  test("L -> array", () => {
    const result = fromAttributeValue({
      L: [{ N: "1" }, { N: "2" }, { N: "3" }],
    });
    expect(result).toEqual([1, 2, 3]);
  });

  test("M -> object", () => {
    const result = fromAttributeValue({
      M: {
        name: { S: "Alice" },
        age: { N: "30" },
      },
    });
    expect(result).toEqual({ name: "Alice", age: 30 });
  });

  test("SS -> Set of strings", () => {
    const result = fromAttributeValue({ SS: ["a", "b", "c"] });
    expect(result).toEqual(new Set(["a", "b", "c"]));
  });

  test("NS -> Set of numbers", () => {
    const result = fromAttributeValue({ NS: ["1", "2", "3"] });
    expect(result).toEqual(new Set(["1", "2", "3"]));
  });

  test("BS -> Set of binary", () => {
    const binary = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    const result = fromAttributeValue({ BS: binary });
    expect(result).toEqual(new Set(binary));
  });

  test("nested structure", () => {
    const result = fromAttributeValue({
      M: {
        id: { S: "123" },
        name: { S: "Alice" },
        tags: {
          L: [{ S: "developer" }, { S: "typescript" }],
        },
        metadata: {
          M: {
            count: { N: "42" },
          },
        },
      },
    });
    expect(result).toEqual({
      id: "123",
      name: "Alice",
      tags: ["developer", "typescript"],
      metadata: {
        count: 42,
      },
    });
  });

  test("unknown attribute value throws error", () => {
    expect(() => fromAttributeValue({} as AttributeValue)).toThrow();
  });
});

describe("toAttributeType", () => {
  test("String schema -> S", () => {
    expect(toAttributeType(S.String)).toBe("S");
  });

  test("Number schema -> N", () => {
    expect(toAttributeType(S.Number)).toBe("N");
  });

  test("Struct schema -> M", () => {
    expect(
      toAttributeType(
        S.Struct({
          name: S.String,
          age: S.Number,
        }),
      ),
    ).toBe("M");
  });

  test("Record schema -> M", () => {
    expect(toAttributeType(S.Record(S.String, S.String))).toBe("M");
  });

  test("Map schema -> M", () => {
    expect(toAttributeType(S.ReadonlyMap(S.String, S.String))).toBe("M");
  });

  test("Array/List schema -> L", () => {
    expect(toAttributeType(S.Array(S.String))).toBe("L");
  });

  test("Set of strings -> SS", () => {
    expect(toAttributeType(S.ReadonlySet(S.String))).toBe("SS");
  });

  test("Set of numbers -> NS", () => {
    expect(toAttributeType(S.ReadonlySet(S.Number))).toBe("NS");
  });

  test("Class schema -> M", () => {
    class User extends S.Class<User>("User")({
      name: S.String,
      age: S.Number,
    }) {}
    expect(toAttributeType(User)).toBe("M");
  });

  test("default fallback -> S", () => {
    expect(toAttributeType(S.Boolean)).toBe("S");
  });
});

describe("isMapSchemaType", () => {
  test("Map schema", () => {
    expect(isMapSchemaType(S.ReadonlyMap(S.String, S.String))).toBe(true);
  });

  test("Record schema", () => {
    expect(isMapSchemaType(S.Record(S.String, S.String))).toBe(true);
  });

  test("Struct schema", () => {
    expect(
      isMapSchemaType(
        S.Struct({
          name: S.String,
          age: S.Number,
        }),
      ),
    ).toBe(true);
  });

  test("Class schema", () => {
    class User extends S.Class<User>("User")({
      name: S.String,
      age: S.Number,
    }) {}
    expect(isMapSchemaType(User)).toBe(true);
  });

  test("not a map schema", () => {
    expect(isMapSchemaType(S.String)).toBe(false);
    expect(isMapSchemaType(S.Number)).toBe(false);
    expect(isMapSchemaType(S.Array(S.String))).toBe(false);
  });
});

describe("isStringSetSchema", () => {
  test("Set of strings", () => {
    expect(isStringSetSchema(S.ReadonlySet(S.String))).toBe(true);
  });

  test("not a string set", () => {
    expect(isStringSetSchema(S.ReadonlySet(S.Number))).toBe(false);
    expect(isStringSetSchema(S.String)).toBe(false);
    expect(isStringSetSchema(S.Array(S.String))).toBe(false);
  });
});

describe("isNumberSetSchema", () => {
  test("Set of numbers", () => {
    expect(isNumberSetSchema(S.ReadonlySet(S.Number))).toBe(true);
  });

  test("not a number set", () => {
    expect(isNumberSetSchema(S.ReadonlySet(S.String))).toBe(false);
    expect(isNumberSetSchema(S.Number)).toBe(false);
    expect(isNumberSetSchema(S.Array(S.Number))).toBe(false);
  });
});

describe("round-trip conversions", () => {
  test("string", async () => {
    const original = "hello";
    const attr = await Effect.runPromise(toAttributeValue(original));
    const result = fromAttributeValue(attr);
    expect(result).toBe(original);
  });

  test("number", async () => {
    const original = 42;
    const attr = await Effect.runPromise(toAttributeValue(original));
    const result = fromAttributeValue(attr);
    expect(result).toBe(original);
  });

  test("boolean", async () => {
    const original = true;
    const attr = await Effect.runPromise(toAttributeValue(original));
    const result = fromAttributeValue(attr);
    expect(result).toBe(original);
  });

  test("null", async () => {
    const original = null;
    const attr = await Effect.runPromise(toAttributeValue(original));
    const result = fromAttributeValue(attr);
    expect(result).toBe(original);
  });

  test("array", async () => {
    const original = [1, "two", true];
    const attr = await Effect.runPromise(toAttributeValue(original));
    const result = fromAttributeValue(attr);
    expect(result).toEqual(original);
  });

  test("object", async () => {
    const original = { name: "Alice", age: 30, active: true };
    const attr = await Effect.runPromise(toAttributeValue(original));
    const result = fromAttributeValue(attr);
    expect(result).toEqual(original);
  });

  test("Set of strings", async () => {
    const original = new Set(["a", "b", "c"]);
    const attr = await Effect.runPromise(toAttributeValue(original));
    const result = fromAttributeValue(attr);
    expect(result).toEqual(original);
  });

  test("complex nested structure", async () => {
    const original = {
      id: "123",
      name: "Alice",
      age: 30,
      active: true,
      tags: ["developer", "typescript"],
      metadata: {
        created: "2023-01-01",
        count: 42,
      },
    };
    const attr = await Effect.runPromise(toAttributeValue(original));
    const result = fromAttributeValue(attr);
    expect(result).toEqual(original);
  });
});
