import {
  PreviewAutomationReviewSnapshot as PreviewAutomationReviewSnapshotSchema,
  type DesktopPreviewAutomationSnapshotOptions,
  type PreviewAutomationReviewSnapshot,
  type PreviewAutomationSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeReviewSnapshot = Schema.decodeUnknownSync(PreviewAutomationReviewSnapshotSchema);

const isReviewSnapshotRequest = (input: unknown): boolean =>
  typeof input === "object" &&
  input !== null &&
  !Array.isArray(input) &&
  "mode" in input &&
  input.mode === "review";

export async function capturePreviewAutomationSnapshotResponse(input: {
  readonly requestInput: unknown;
  readonly capture: (
    options?: DesktopPreviewAutomationSnapshotOptions,
  ) => Promise<PreviewAutomationSnapshot>;
}): Promise<PreviewAutomationSnapshot | PreviewAutomationReviewSnapshot> {
  if (!isReviewSnapshotRequest(input.requestInput)) {
    return await input.capture();
  }
  const snapshot = await input.capture({ mode: "review" });
  return decodeReviewSnapshot(snapshot);
}
