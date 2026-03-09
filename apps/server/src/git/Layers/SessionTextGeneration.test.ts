import { describe, expect, it } from "vitest";

import { SessionTextGenerationLive } from "./SessionTextGeneration.ts";

describe("SessionTextGeneration", () => {
  it("exports a valid Layer", () => {
    expect(SessionTextGenerationLive).toBeDefined();
  });
});
