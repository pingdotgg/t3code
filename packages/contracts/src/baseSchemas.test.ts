import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  ForwardCompatibleUnion,
  ForwardCompatibleUnionArray,
  isUnknownUnionMember,
  UnknownUnionMember,
} from "./baseSchemas.ts";

const at = "2026-10-05T00:00:00.000Z";
const Shape = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("circle"), radius: Schema.Number, at: Schema.DateTimeUtc }),
  Schema.Struct({ kind: Schema.Literal("square"), side: Schema.Number }),
]);
const members = Shape.members;
/** How clients decode: the JSON wire codec over the runtime schema. */
const fromWire = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(schema) as never) as (value: unknown) => S["Type"];

describe("ForwardCompatibleArray", () => {
  it("decodes elements through their own codec and drops ones it cannot read", () => {
    const decoded = fromWire(ForwardCompatibleArray(Shape))([
      { kind: "circle", radius: 1, at },
      { kind: "triangle" },
      { kind: "square", side: "wide" },
    ]);
    expect(decoded).toHaveLength(1);
    expect(DateTime.isDateTime((decoded[0] as { at: unknown }).at)).toBe(true);
  });

  it("applies decoding defaults instead of failing", () => {
    const WithDefault = Schema.Struct({
      name: Schema.String,
      count: Schema.optionalKey(Schema.Number).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed(7)),
      ),
    });
    expect(Schema.decodeUnknownSync(ForwardCompatibleArray(WithDefault))([{ name: "a" }])).toEqual([
      { name: "a", count: 7 },
    ]);
  });
});

describe("ForwardCompatibleUnion", () => {
  const decode = fromWire(ForwardCompatibleUnion(members, "kind"));

  it("decodes a member from a newer server as unknown", () => {
    const decoded = decode({ kind: "triangle", corners: 3 });
    expect(isUnknownUnionMember(decoded)).toBe(true);
    expect(decoded).toEqual(new UnknownUnionMember("kind", "triangle"));
  });

  it("decodes known members in full, transformations included", () => {
    const decoded = decode({ kind: "circle", radius: 1, at });
    expect(isUnknownUnionMember(decoded)).toBe(false);
    expect(DateTime.isDateTime((decoded as { at: unknown }).at)).toBe(true);
  });

  it("still fails a known member whose payload is broken", () => {
    expect(() => decode({ kind: "square", side: "wide" })).toThrow();
  });

  it("refuses to encode an unknown member", () => {
    const encode = Schema.encodeSync(ForwardCompatibleUnion(members, "kind") as never);
    expect(() => encode(new UnknownUnionMember("kind", "triangle") as never)).toThrow();
  });
});

describe("ForwardCompatibleUnionArray", () => {
  it("keeps a known member however its fields are named", () => {
    const Flagged = Schema.Struct({
      kind: Schema.Literal("flag"),
      _unknown: Schema.Literal(true),
      tag: Schema.String,
      value: Schema.String,
    });
    const flag = { kind: "flag", _unknown: true, tag: "kind", value: "x" };
    expect(fromWire(ForwardCompatibleUnionArray([Flagged], "kind"))([flag])).toEqual([flag]);
  });

  const decode = fromWire(ForwardCompatibleUnionArray(members, "kind"));

  it("drops members a newer server added and keeps the rest", () => {
    const decoded = decode([
      { kind: "triangle" },
      { kind: "circle", radius: 1, at },
      { kind: "square", side: 2 },
    ]);
    expect(decoded.map((shape) => shape.kind)).toEqual(["circle", "square"]);
  });

  it("fails when a known member is broken, so real bugs stay visible", () => {
    expect(() => decode([{ kind: "square", side: "wide" }])).toThrow();
  });

  it("encodes as a plain array", () => {
    const encode = Schema.encodeSync(
      Schema.toCodecJson(ForwardCompatibleUnionArray(members, "kind")),
    );
    const square = { kind: "square" as const, side: 2 };
    expect(encode([square])).toEqual([square]);
  });
});
