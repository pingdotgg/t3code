import { decodeStagedBatch, encodeStagedBatch } from "@/Git/PushWire.ts";
import { ObjectType } from "@/Git/Protocol/ObjectCodec.ts";
import { describe, expect, test } from "alchemy-test";

describe("push batch codec", () => {
  test("inline and promoted rows round-trip", () => {
    const rows = [
      {
        oid: "a".repeat(40),
        type: ObjectType.blob,
        size: 10,
        zdata: new Uint8Array([1, 2, 3]),
        zsize: 3,
      },
      {
        oid: "b".repeat(40),
        type: ObjectType.blob,
        size: 4096,
        zdata: new Uint8Array(0),
        zsize: 900,
        pack: { packId: "wire-01H", offset: 12345 },
      },
      {
        oid: "c".repeat(40),
        type: ObjectType.tree,
        size: 60,
        zdata: new Uint8Array([9, 9, 9, 9]),
        zsize: undefined,
      },
    ];
    const decoded = decodeStagedBatch(encodeStagedBatch(rows));
    expect(decoded.length).toBe(3);
    expect(decoded.map((r) => r.oid)).toEqual(rows.map((r) => r.oid));
    expect(Array.from(decoded[0]!.zdata)).toEqual([1, 2, 3]);
    expect(decoded[1]!.zdata.byteLength).toBe(0);
    expect(decoded[1]!.pack).toEqual({ packId: "wire-01H", offset: 12345 });
    expect(decoded[1]!.zsize).toBe(900);
    expect(Array.from(decoded[2]!.zdata)).toEqual([9, 9, 9, 9]);
    expect(decoded[2]!.type).toBe(ObjectType.tree);
  });
  test("an empty batch encodes to a header only", () => {
    expect(decodeStagedBatch(encodeStagedBatch([])).length).toBe(0);
  });
});
