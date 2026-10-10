import { expect, it } from "vite-plus/test";
import { PreviewCaptureFailure } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { normalizeCaptureFailure } from "./captureErrors.ts";
const encodeCaptureFailure = Schema.encodeSync(PreviewCaptureFailure);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it("preserves a native pixel capture timeout across the encoded IPC result", () => {
  const failure = normalizeCaptureFailure(
    {
      _tag: "PreviewOperationError",
      operation: "captureScreenshot.capturePage",
      cause: new Cause.TimeoutError(),
    },
    "screenshot",
  );
  const encoded = encodeCaptureFailure(failure);
  expect(encoded).toEqual({
    _tag: "PreviewCaptureFailure",
    reason: "capture-timeout",
    stage: "capture-page",
  });
  expect(encodeJson(encoded)).not.toContain("stack");
});

it.each([
  ["PreviewTabNotFoundError", "renderer-unavailable"],
  ["PreviewWebContentsNotFoundError", "renderer-unavailable"],
  ["PreviewMainWindowClosedError", "renderer-unavailable"],
  ["PreviewWebviewNotInitializedError", "capture-unavailable"],
  ["PreviewRecordingCaptureUnavailableError", "capture-unavailable"],
  ["PreviewRecordingArmConflictError", "recording-conflict"],
])("classifies %s without transporting its arbitrary fields", (tag, reason) => {
  const failure = normalizeCaptureFailure(
    { _tag: tag, message: "secret page content", stack: "secret stack" },
    "recording-start",
  );
  expect(failure.reason).toBe(reason);
  expect(encodeJson(encodeCaptureFailure(failure))).not.toContain("secret");
});

it.each(["captureScreenshot.capturePage"])(
  "classifies the exact Electron surface rejection for %s",
  (operation) => {
    const failure = normalizeCaptureFailure(
      {
        _tag: "PreviewOperationError",
        operation,
        cause: new Error("Current display surface not available for capture"),
      },
      "screenshot",
    );
    expect(encodeCaptureFailure(failure)).toEqual({
      _tag: "PreviewCaptureFailure",
      reason: "capture-unavailable",
      stage: "capture-page",
    });
  },
);

it("keeps extended messages and unrelated operations generic with the screenshot stage", () => {
  for (const [operation, message] of [
    ["captureScreenshot.capturePage", "Current display surface not available for capture secret"],
    ["captureScreenshot.writeFile", "Current display surface not available for capture"],
  ]) {
    const failure = normalizeCaptureFailure(
      { _tag: "PreviewOperationError", operation, cause: new Error(message) },
      "screenshot",
    );
    expect(failure.reason).toBe("capture-failed");
    expect(failure.message).not.toContain("secret");
    if (operation === "captureScreenshot.writeFile") {
      expect(failure.stage).toBe("screenshot");
      expect(failure.message).toContain("during screenshot");
    }
  }
});

it("does not classify an arbitrary message as a timeout", () => {
  const failure = normalizeCaptureFailure(
    new Error("TimeoutError secret page content"),
    "screenshot",
  );
  expect(failure.reason).toBe("capture-failed");
  expect(failure.message).not.toContain("secret");
});
