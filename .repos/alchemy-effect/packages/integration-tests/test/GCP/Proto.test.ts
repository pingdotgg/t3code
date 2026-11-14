import { matchesDesired } from "@alchemy.run/gcp/Proto";
import { describe, expect, test } from "@alchemy.run/test";

describe("matchesDesired", () => {
  test(
    "ignores unspecified observed keys and accepts omitted proto defaults",
    () => {
      expect(matchesDesired({ enabled: false, serverGenerated: "value" }, { enabled: false })).toBe(
        true,
      );
      expect(matchesDesired({}, { enabled: false, count: 0, name: "" })).toBe(true);
      expect(matchesDesired({}, { values: [] })).toBe(true);
    },
    { tags: ["unit", "provider:gcp", "local"] },
  );

  test(
    "does not treat an explicit null as an omitted field",
    () => {
      expect(matchesDesired({}, { value: null })).toBe(false);
      expect(matchesDesired({ value: null }, { value: null })).toBe(true);
    },
    { tags: ["unit", "provider:gcp", "local"] },
  );
});
