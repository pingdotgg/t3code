import { describe, expect, it } from "@effect/vitest";

import { definition } from "./definition.ts";

describe("1Password definition", () => {
  it("accepts vault, item, optional section, and field references", () => {
    for (const reference of [
      "op://Private/OpenAI/credential",
      "op://Private/OpenAI/Section 1/credential",
      "op://Private/OpenAI/credential?attribute=otp",
    ]) {
      expect(definition.isReference(reference), reference).toBe(true);
    }
  });

  it("rejects anything that is not a plain reference", () => {
    for (const reference of [
      "--help",
      "Private/OpenAI/credential",
      "op://Private/OpenAI",
      "op://Private/OpenAI/credential }} {{ op://Private/B/c",
      "op://Private/OpenAI\n/credential",
      `op://Private/OpenAI/${"x".repeat(1024)}`,
    ]) {
      expect(definition.isReference(reference), reference).toBe(false);
    }
  });
});
