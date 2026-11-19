import { describe, expect, it } from "vite-plus/test";

import { threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";

describe("threadRelationshipStatusLabel", () => {
  it("labels unavailable relationship rows without showing a stale terminal status", () => {
    expect(threadRelationshipStatusLabel("unavailable")).toBe("Unavailable");
  });
});
