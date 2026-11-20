import { describe, expect, it } from "@alchemy.run/test";
import {
  concreteIdOf,
  isPrismaDevId,
  unresolvedAppIdOf,
  unresolvedDatabaseIdOf,
  unresolvedProjectIdOf,
} from "../../../prisma/src/internal/Refs.ts";

describe("Prisma Refs", { tags: ["unit", "provider:prisma", "local"] }, () => {
  it("treats missing unresolved references as unknown", () => {
    expect(unresolvedProjectIdOf(undefined)).toBeUndefined();
    expect(unresolvedDatabaseIdOf(undefined)).toBeUndefined();
    expect(unresolvedAppIdOf(undefined)).toBeUndefined();
  });

  it("treats local dev placeholders as unknown live ids", () => {
    expect(isPrismaDevId("dev:project:Project")).toBe(true);
    expect(concreteIdOf("dev:project:Project")).toBeUndefined();
    expect(unresolvedProjectIdOf("dev:project:Project")).toBeUndefined();
    expect(unresolvedDatabaseIdOf("dev:database:Database")).toBeUndefined();
    expect(unresolvedAppIdOf("dev:app:App")).toBeUndefined();
  });
});
