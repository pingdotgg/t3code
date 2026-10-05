import * as GCP from "@/GCP";
import {
  decodeFields,
  encodeFields,
  encodeValue,
  fieldPath,
} from "@/GCP/Firestore/Values.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: GCP.providers() });

const when = new Date("2026-01-02T03:04:05.678Z");
const sample = {
  str: "hello",
  int: 42,
  negative: -7,
  double: 3.5,
  big: 9007199254740993n,
  yes: true,
  no: false,
  nothing: null,
  when,
  bytes: new Uint8Array([0, 1, 254, 255]),
  list: [1, "two", false, null, { x: 3 }],
  nested: { a: { b: "deep" }, n: 1.25 },
};

/** Comparable view of decoded fields (bigint, Date and bytes flattened). */
const describeFields = (fields: Record<string, unknown>) => ({
  str: fields.str,
  int: fields.int,
  negative: fields.negative,
  double: fields.double,
  big: typeof fields.big === "bigint" ? fields.big.toString() : fields.big,
  yes: fields.yes,
  no: fields.no,
  nothing: fields.nothing,
  when: fields.when instanceof Date ? fields.when.toISOString() : fields.when,
  bytes: fields.bytes instanceof Uint8Array ? [...fields.bytes] : fields.bytes,
  list: fields.list,
  nested: fields.nested,
});

const expectedFields = {
  str: "hello",
  int: 42,
  negative: -7,
  double: 3.5,
  big: "9007199254740993",
  yes: true,
  no: false,
  nothing: null,
  when: "2026-01-02T03:04:05.678Z",
  bytes: [0, 1, 254, 255],
  list: [1, "two", false, null, { x: 3 }],
  nested: { a: { b: "deep" }, n: 1.25 },
};

describe("Values codec", () => {
  test(
    "encodes plain JavaScript to Firestore Values",
    Effect.sync(() => {
      expect(encodeFields(sample)).toEqual({
        str: { stringValue: "hello" },
        int: { integerValue: "42" },
        negative: { integerValue: "-7" },
        double: { doubleValue: 3.5 },
        big: { integerValue: "9007199254740993" },
        yes: { booleanValue: true },
        no: { booleanValue: false },
        nothing: { nullValue: "NULL_VALUE" },
        when: { timestampValue: "2026-01-02T03:04:05.678Z" },
        bytes: { bytesValue: "AAH+/w==" },
        list: {
          arrayValue: {
            values: [
              { integerValue: "1" },
              { stringValue: "two" },
              { booleanValue: false },
              { nullValue: "NULL_VALUE" },
              { mapValue: { fields: { x: { integerValue: "3" } } } },
            ],
          },
        },
        nested: {
          mapValue: {
            fields: {
              a: { mapValue: { fields: { b: { stringValue: "deep" } } } },
              n: { doubleValue: 1.25 },
            },
          },
        },
      });
      expect(encodeFields({ skipped: undefined })).toEqual({});
      expect(encodeValue(undefined)).toEqual({ nullValue: "NULL_VALUE" });
    }),
    { tags: ["unit", "provider:gcp", "provider:gcp:firestore", "local"] },
  );

  test(
    "decodes Firestore Values to plain JavaScript",
    Effect.sync(() => {
      expect(describeFields(decodeFields(encodeFields(sample)))).toEqual(
        expectedFields,
      );
      expect(
        decodeFields({
          geo: { geoPointValue: { latitude: 1.5, longitude: -2 } },
          ref: { referenceValue: "projects/p/databases/d/documents/a/b" },
          emptyList: { arrayValue: {} },
          emptyMap: { mapValue: {} },
        }),
      ).toEqual({
        geo: { latitude: 1.5, longitude: -2 },
        ref: "projects/p/databases/d/documents/a/b",
        emptyList: [],
        emptyMap: {},
      });
    }),
    { tags: ["unit", "provider:gcp", "provider:gcp:firestore", "local"] },
  );

  test(
    "quotes non-identifier update-mask field paths",
    Effect.sync(() => {
      expect(fieldPath("plain_Name1")).toEqual("plain_Name1");
      expect(fieldPath("has space")).toEqual("`has space`");
      expect(fieldPath("a.b")).toEqual("`a.b`");
      expect(fieldPath("tick`")).toEqual("`tick\\``");
    }),
    { tags: ["unit", "provider:gcp", "provider:gcp:firestore", "local"] },
  );
});
