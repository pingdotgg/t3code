import { describe, expect, it } from "@effect/vitest";
import { SecretReference } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { definition } from "./definition.ts";

const decodeSecretReference = Schema.decodeUnknownSync(SecretReference);

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

  it("keeps the edge spaces of a field label in a copied reference", () => {
    for (const reference of [
      "op://Private/OpenAI/credential ",
      "op://Private/OpenAI/ credential",
    ]) {
      const decoded = decodeSecretReference({ provider: "op", reference });
      expect(decoded.reference, reference).toBe(reference);
      expect(definition.isReference(decoded.reference), reference).toBe(true);
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
