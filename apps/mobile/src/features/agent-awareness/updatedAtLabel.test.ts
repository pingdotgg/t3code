import { describe, expect, it } from "@effect/vitest";

import { formatAgentActivityUpdatedAtLabel } from "./updatedAtLabel";

describe("formatAgentActivityUpdatedAtLabel", () => {
  it("formats ISO timestamps without using ambient time APIs", () => {
    expect(formatAgentActivityUpdatedAtLabel("2026-05-25T00:03:00.000Z")).toBe("12:03");
    expect(formatAgentActivityUpdatedAtLabel("2026-05-25T09:45:00.000Z")).toBe("9:45");
    expect(formatAgentActivityUpdatedAtLabel("2026-05-25T13:07:00.000Z")).toBe("1:07");
  });

  it("uses now for malformed timestamps", () => {
    expect(formatAgentActivityUpdatedAtLabel("not-a-date")).toBe("now");
    expect(formatAgentActivityUpdatedAtLabel("2026-05-25T24:00:00.000Z")).toBe("now");
  });
});
