import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findGeneratedImagePath } from "./GeneratedImageResolver.ts";

const ACTIVITY_ID = EventId.make("activity-generated-image");

function activity(
  item: Record<string, unknown>,
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity {
  return {
    id: ACTIVITY_ID,
    tone: "tool",
    kind: "tool.completed",
    summary: "Image view",
    payload: { data: { item } },
    turnId: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("generated image resolution", () => {
  it("reads the saved path from a completed image generation activity", () => {
    const path = "/provider/session/generated.png";
    expect(
      findGeneratedImagePath(
        [activity({ type: "imageGeneration", status: "completed", savedPath: path })],
        ACTIVITY_ID,
      ),
    ).toBe(path);
  });

  it("preserves filesystem-significant whitespace in the saved path", () => {
    const path = "/provider/session/ generated.png ";
    expect(
      findGeneratedImagePath(
        [activity({ type: "imageGeneration", status: "completed", savedPath: path })],
        ACTIVITY_ID,
      ),
    ).toBe(path);
    expect(
      findGeneratedImagePath(
        [activity({ type: "imageGeneration", status: "completed", savedPath: "   " })],
        ACTIVITY_ID,
      ),
    ).toBeNull();
  });

  it("rejects other image activities, incomplete generations, and mismatched ids", () => {
    expect(
      findGeneratedImagePath(
        [activity({ type: "imageView", status: "completed", path: "/tmp/viewed.png" })],
        ACTIVITY_ID,
      ),
    ).toBeNull();
    expect(
      findGeneratedImagePath(
        [
          activity({
            type: "imageGeneration",
            status: "inProgress",
            savedPath: "/tmp/generated.png",
          }),
        ],
        ACTIVITY_ID,
      ),
    ).toBeNull();
    expect(
      findGeneratedImagePath(
        [
          activity(
            {
              type: "imageGeneration",
              status: "completed",
              savedPath: "/tmp/generated.png",
            },
            { kind: "tool.updated" },
          ),
        ],
        ACTIVITY_ID,
      ),
    ).toBeNull();
    expect(
      findGeneratedImagePath(
        [
          activity({
            type: "imageGeneration",
            status: "completed",
            savedPath: "/tmp/generated.png",
          }),
        ],
        EventId.make("activity-other"),
      ),
    ).toBeNull();
  });
});
