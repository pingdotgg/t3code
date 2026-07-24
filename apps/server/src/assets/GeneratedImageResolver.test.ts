import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  findGeneratedImagePath,
  isGeneratedImageFileLookupRetryable,
  retryGeneratedImageFileLookup,
} from "./GeneratedImageResolver.ts";

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
    createdAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("generated image resolution", () => {
  it("reads the saved path from a completed image generation activity", () => {
    const path = "/provider/session/generated.png";
    expect(
      findGeneratedImagePath(
        [
          activity({
            type: "imageGeneration",
            status: "completed",
            savedPath: path,
          }),
        ],
        ACTIVITY_ID,
      ),
    ).toBe(path);
  });

  it("rejects non-generation, incomplete, and mismatched activities", () => {
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

  effectIt.live("retries the projection lookup until the generated image appears", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const result = yield* retryGeneratedImageFileLookup(
        Effect.suspend(() => {
          attempts += 1;
          const generatedImagePath = findGeneratedImagePath(
            attempts < 3
              ? []
              : [
                  activity({
                    type: "imageGeneration",
                    status: "completed",
                    savedPath: "/tmp/generated.png",
                  }),
                ],
            ACTIVITY_ID,
          );
          return generatedImagePath
            ? Effect.succeed(generatedImagePath)
            : Effect.fail({ _tag: "AssetGeneratedImageNotFoundError" as const });
        }),
      );

      expect(result).toBe("/tmp/generated.png");
      expect(attempts).toBe(3);
      expect(
        isGeneratedImageFileLookupRetryable({ _tag: "AssetGeneratedImageNotFoundError" }),
      ).toBe(true);
      expect(
        isGeneratedImageFileLookupRetryable({ _tag: "AssetGeneratedImageInspectionError" }),
      ).toBe(false);
    }),
  );
});
