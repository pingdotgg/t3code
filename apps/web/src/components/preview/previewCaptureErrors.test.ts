import { expect, it } from "vite-plus/test";
import { PreviewCaptureFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { unwrapPreviewCaptureResult } from "./previewCaptureErrors";

const encodeCaptureFailure = Schema.encodeSync(PreviewCaptureFailure);

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
