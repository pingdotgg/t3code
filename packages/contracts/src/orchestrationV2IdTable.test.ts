import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { withRecordIdTable } from "./orchestrationV2IdTable.ts";

const Page = withRecordIdTable(
  Schema.Struct({
    rows: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        count: Schema.Number,
        parentIds: Schema.Array(Schema.String),
        mergedId: Schema.optional(Schema.String),
        item: Schema.Struct({ ownerId: Schema.NullOr(Schema.String), legacyId: Schema.Number }),
      }),
    ),
    idTable: Schema.optionalKey(Schema.Literal(true)),
  }),
  () => null,
);
const encode = Schema.encodeSync(Schema.toCodecJson(Page));
const decode = Schema.decodeUnknownSync(Schema.toCodecJson(Page));

describe("record ID table", () => {
  it("interns record ID slots and restores them exactly, numbers included", () => {
    const value = {
      rows: [
        { id: "row:a", count: 7, parentIds: ["row:b"], item: { ownerId: "row:b", legacyId: 3 } },
        { id: "row:b", count: 3, parentIds: [], item: { ownerId: null, legacyId: 0 } },
      ],
    };
    const wire = JSON.parse(JSON.stringify(encode({ ...value, idTable: true })));

    expect(wire).toEqual({
      rows: [
        { id: 0, count: 7, parentIds: [1], item: { ownerId: 1, legacyId: 2 } },
        { id: 1, count: 3, parentIds: [], item: { ownerId: null, legacyId: 3 } },
      ],
      ids: ["row:a", "row:b", 3, 0],
    });
    expect(decode(wire)).toEqual(value);
    // The table is consumed, so a second decode of the same object cannot remap numbers.
    expect(decode(wire)).toEqual(value);
  });

  it("rejects an index outside the table, even in an optional slot", () => {
    const wire = {
      rows: [{ id: 0, count: 1, parentIds: [], mergedId: 5, item: { ownerId: null, legacyId: 0 } }],
      ids: ["row:a"],
    };

    expect(() => decode(wire)).toThrow(/mergedId/);
  });

  it("sends and reads the plain form without the marker", () => {
    const value = {
      rows: [{ id: "row:a", count: 1, parentIds: [], item: { ownerId: null, legacyId: 1 } }],
    };

    expect(encode(value)).toEqual(value);
    expect(decode(value)).toEqual(value);
  });
});
