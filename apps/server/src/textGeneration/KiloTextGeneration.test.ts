import { describe, expect, it } from "@effect/vitest";

import { sanitizeKiloBranchName } from "./KiloTextGeneration.ts";

describe("KiloTextGeneration", () => {
  it("removes repeated quote and code-fence wrappers from branch names", () => {
    expect(sanitizeKiloBranchName("```feature/kilo-provider```")).toBe("feature/kilo-provider");
    expect(sanitizeKiloBranchName('""feature-name""')).toBe("feature-name");
  });
});
