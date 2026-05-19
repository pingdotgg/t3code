import { describe, expect, it } from "vitest";

import { sanitizePiAssistantTextDelta } from "./PiAdapter.ts";

describe("sanitizePiAssistantTextDelta", () => {
  it("removes Pi CLI update notices while preserving assistant text", () => {
    expect(
      sanitizePiAssistantTextDelta(
        "New version available: v0.75.3 (installed v0.73.1). Run: npm i -g @earendil-works/pi-coding-agent PI_OK",
      ),
    ).toBe("PI_OK");
  });

  it("leaves normal assistant text untouched", () => {
    expect(sanitizePiAssistantTextDelta("PI_OK")).toBe("PI_OK");
  });
});
