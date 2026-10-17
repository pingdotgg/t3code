import { expect, expectTypeOf, it } from "vite-plus/test";
import {
  PreviewCaptureFailure,
  type DesktopPreviewBridge,
  type DesktopPreviewScreenshotArtifact,
  type PreviewCaptureFailureEncoded,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { unwrapPreviewCaptureResult } from "./previewCaptureErrors";
import type { previewBridge } from "./previewBridge";

const encodeCaptureFailure = Schema.encodeSync(PreviewCaptureFailure);

it("keeps raw capture failures encoded and decoded bridge success types exact", () => {
  expectTypeOf<ReturnType<DesktopPreviewBridge["captureScreenshot"]>>().toEqualTypeOf<
    Promise<DesktopPreviewScreenshotArtifact | PreviewCaptureFailureEncoded>
  >();
  expectTypeOf<ReturnType<DesktopPreviewBridge["recording"]["startScreencast"]>>().toEqualTypeOf<
    Promise<void | PreviewCaptureFailureEncoded>
  >();
  expectTypeOf<ReturnType<NonNullable<typeof previewBridge>["captureScreenshot"]>>().toEqualTypeOf<
    Promise<DesktopPreviewScreenshotArtifact>
  >();
  expectTypeOf<
    ReturnType<NonNullable<typeof previewBridge>["recording"]["startScreencast"]>
  >().toEqualTypeOf<Promise<void>>();
});

it("rejects a plain contextBridge failure with the native capture diagnostic", () => {
  const encoded = encodeCaptureFailure(
    new PreviewCaptureFailure({ reason: "capture-timeout", stage: "capture-page" }),
  );
  let cause: unknown;
  try {
    unwrapPreviewCaptureResult(encoded);
  } catch (error) {
    cause = error;
  }
  expect(cause).toBeInstanceOf(PreviewCaptureFailure);
  expect(cause).toMatchObject({ reason: "capture-timeout", stage: "capture-page" });
  expect((cause as PreviewCaptureFailure).message).toContain("timed out during capture-page");
});

it("leaves successful capture results unchanged", () => {
  const result = { screenshot: { width: 100, height: 80 } };
  expect(unwrapPreviewCaptureResult(result)).toBe(result);
  expect(unwrapPreviewCaptureResult(undefined)).toBeUndefined();
});
