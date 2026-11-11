import { matches, sort } from "@alchemy.run/domain/Filter";
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";

interface Row {
  readonly name: string;
  readonly balance: number;
  readonly frozen: boolean;
  readonly closedAt: DateTime.Utc | null;
  readonly tags: ReadonlyArray<string>;
  readonly owner: { readonly country: string };
}

const row: Row = {
  name: "savings",
  balance: 120,
  frozen: false,
  closedAt: null,
  tags: ["vip", "eu"],
  owner: { country: "NZ" },
};

describe("Domain Filter", { tags: ["unit", "local"] }, () => {
  it("treats bare values as equality and sibling keys as AND", () => {
    expect(matches<Row>({ frozen: false, name: "savings" }, row)).toBe(true);
    expect(matches<Row>({ frozen: true, name: "savings" }, row)).toBe(false);
  });

  it("supports comparison, string and set operators", () => {
    expect(matches<Row>({ balance: { gte: 100, lt: 200 } }, row)).toBe(true);
    expect(matches<Row>({ balance: { gt: 120 } }, row)).toBe(false);
    expect(matches<Row>({ name: { startsWith: "sav", contains: "ing" } }, row)).toBe(true);
    expect(matches<Row>({ name: { in: ["checking", "savings"] } }, row)).toBe(true);
    expect(matches<Row>({ name: { notIn: ["savings"] } }, row)).toBe(false);
  });

  it("matches nulls, nested objects and arrays", () => {
    expect(matches<Row>({ closedAt: null }, row)).toBe(true);
    expect(matches<Row>({ closedAt: { not: null } }, row)).toBe(false);
    expect(matches<Row>({ owner: { country: "NZ" } }, row)).toBe(true);
    expect(matches<Row>({ tags: { has: "vip", length: { gte: 2 } } }, row)).toBe(true);
    expect(matches<Row>({ tags: { some: { startsWith: "e" }, none: "us" } }, row)).toBe(true);
  });

  it("combines with AND, OR and NOT", () => {
    expect(matches<Row>({ OR: [{ frozen: true }, { balance: { gt: 100 } }] }, row)).toBe(true);
    expect(matches<Row>({ NOT: { owner: { country: "NZ" } } }, row)).toBe(false);
    expect(matches<Row>({ AND: [{ frozen: false }, { NOT: { name: "checking" } }] }, row)).toBe(
      true,
    );
  });

  it("compares dates, including ISO strings that crossed the wire", () => {
    const closed = { ...row, closedAt: DateTime.makeUnsafe("2026-10-09T00:00:00Z") };
    expect(
      matches<Row>({ closedAt: { gt: DateTime.makeUnsafe("2026-01-01T00:00:00Z") } }, closed),
    ).toBe(true);
    expect(matches({ closedAt: { lt: "2026-01-01T00:00:00Z" } } as any, closed)).toBe(false);
  });

  it("sorts by orderBy", () => {
    const rows = [{ n: 2 }, { n: 3 }, { n: 1 }];
    expect(sort(rows, { n: "desc" }).map((r) => r.n)).toEqual([3, 2, 1]);
    expect(sort(rows, { n: "asc" }).map((r) => r.n)).toEqual([1, 2, 3]);
  });
});
