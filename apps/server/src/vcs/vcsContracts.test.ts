import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { VcsDriverKind } from "@forma/contracts";

describe("VCS contracts", () => {
  it("keeps git as a supported driver kind", () => {
    expect(Schema.decodeUnknownSync(VcsDriverKind)("git")).toBe("git");
  });
});
