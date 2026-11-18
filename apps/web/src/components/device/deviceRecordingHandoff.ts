import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { fileContextReference, imageContextReference } from "~/lib/composerContextRecords";
import { formatInlineContextReference } from "~/lib/composerContextReferences";
import { prepareImageForAttachment } from "~/lib/imageCompression";
import { randomUUID } from "~/lib/utils";
import { readComposerImageBytes } from "../chat/composerAttachmentFiles";
import type { DeviceRecorderResult } from "./deviceRecorder";
import {
  buildDeviceRecording,
  formatDeviceRecordingPrompt,
  formatRecordingDuration,
  limitRecordingFrames,
} from "./deviceRecording.logic";

/** Enough frames to follow a flow without burying the agent in near-identical screens. */
const MAX_HANDOFF_FRAMES = 12;

export interface DeviceRecordingHandoff {
  readonly steps: number;
  readonly frames: number;
  readonly video: boolean;
}

/** Puts the step log, frames, and video into the thread's draft, unsent. */
export async function handOffDeviceRecording(input: {
  readonly threadRef: ScopedThreadRef;
  readonly result: DeviceRecorderResult;
  /** Where the recording happened, such as the device name, OS version, and app. */
  readonly context: string;
  readonly videoUnavailableReason: string | null;
}): Promise<DeviceRecordingHandoff> {
  const { result, threadRef } = input;
  const recording = limitRecordingFrames(
    buildDeviceRecording(result.inputs, result.captures),
    MAX_HANDOFF_FRAMES,
  );
  const frameIndices = [
    ...(recording.initialFrame === null ? [] : [recording.initialFrame]),
    ...recording.steps.flatMap((step) => (step.frame === null ? [] : [step.frame])),
  ];
  // Sized so the frames always fit together under the per-message image limit.
  const perFrameBytes = Math.min(
    PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
    Math.floor(PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES / Math.max(1, frameIndices.length)),
  );
  const images = new Map<number, ComposerImageAttachment>();
  for (const [order, index] of frameIndices.entries()) {
    const blob = result.captures[index]?.frame;
    if (!blob) continue;
    const name = `frame-${String(order + 1).padStart(2, "0")}.png`;
    const prepared = await prepareImageForAttachment(
      new File([blob], name, { type: blob.type || "image/png" }),
      perFrameBytes,
    );
    if (!prepared.ok) continue;
    await readComposerImageBytes(prepared.file);
    images.set(index, {
      type: "image",
      id: randomUUID(),
      name: prepared.file.name,
      mimeType: prepared.file.type,
      sizeBytes: prepared.file.size,
      previewUrl: URL.createObjectURL(prepared.file),
      file: prepared.file,
    });
  }

  const store = useComposerDraftStore.getState();
  // A frame can match one from an earlier recording still in the draft; each log needs its own.
  const acceptedImages = new Set(
    store.addImages(threadRef, [...images.values()], { allowDuplicates: true }),
  );
  const videoName = `device-recording.${result.video?.mimeType === "video/mp4" ? "mp4" : "webm"}`;
  const video: ComposerFileAttachment | null = result.video
    ? {
        type: "file",
        id: randomUUID(),
        name: videoName,
        mimeType: result.video.mimeType,
        sizeBytes: result.video.blob.size,
        file: new File([result.video.blob], videoName, { type: result.video.mimeType }),
      }
    : null;
  const videoAttached = video !== null && store.addFiles(threadRef, [video]).includes(video.id);

  const notes: string[] = [];
  if (video && videoAttached) {
    notes.push(
      `Video: ${formatInlineContextReference(fileContextReference(video))}${
        result.video?.truncated ? " (ends early at the attachment size limit)" : ""
      }`,
    );
  } else if (input.videoUnavailableReason) {
    notes.push(`No video: ${input.videoUnavailableReason}`);
  }
  const text = formatDeviceRecordingPrompt({
    header: [
      `Recorded on ${input.context}, ${formatRecordingDuration(result.durationMs)}.`,
      "Each frame is a screenshot taken once input paused after that step.",
    ].join(" "),
    recording,
    frameReference: (frame) => {
      const image = images.get(frame);
      return image && acceptedImages.has(image.id)
        ? formatInlineContextReference(imageContextReference(image))
        : null;
    },
    notes,
  });
  const existing = store.getComposerDraft(threadRef)?.prompt.trimEnd() ?? "";
  store.setPrompt(threadRef, existing ? `${existing}\n\n${text}` : text);
  return {
    steps: recording.steps.length,
    frames: acceptedImages.size,
    video: videoAttached,
  };
}
