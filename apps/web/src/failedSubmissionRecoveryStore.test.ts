import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type {
  ComposerImageAttachment,
  PersistedComposerImageAttachment,
} from "./composerDraftStore";
import {
  FAILED_SUBMISSION_RECOVERY_STORAGE_KEY,
  type FailedSubmissionRecoverySnapshot,
  useFailedSubmissionRecoveryStore,
} from "./failedSubmissionRecoveryStore";

const sourceThreadRef = scopeThreadRef(
  EnvironmentId.make("environment-recovery"),
  ThreadId.make("thread-recovery"),
);

const storageValues = new Map<string, string>();

function installMemoryLocalStorage() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageValues.set(key, value);
      },
      removeItem: (key: string) => {
        storageValues.delete(key);
      },
    },
  });
}

function makeImage(): ComposerImageAttachment {
  const file = new File([new Uint8Array([7])], "original.png", { type: "image/png" });
  return {
    type: "image",
    id: "image-original",
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: "blob:original-preview",
    file,
  };
}

function makeSnapshot(): FailedSubmissionRecoverySnapshot {
  return {
    sourceThreadRef,
    messageId: "message-failed",
    prompt: "Explain this image",
    images: [makeImage()],
    terminalContexts: [
      {
        id: "terminal-context",
        threadId: sourceThreadRef.threadId,
        terminalId: "term-1",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 2,
        text: "terminal output",
        createdAt: "2026-08-10T00:00:00.000Z",
      },
    ],
    elementContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    runtimeMode: "full-access",
    interactionMode: "default",
  };
}

function persistedImage(): PersistedComposerImageAttachment {
  return {
    id: "image-original",
    name: "original.png",
    mimeType: "image/png",
    sizeBytes: 1,
    dataUrl: "data:image/png;base64,Bw==",
  };
}

function resetRecoveryStore() {
  installMemoryLocalStorage();
  localStorage.removeItem(FAILED_SUBMISSION_RECOVERY_STORAGE_KEY);
  useFailedSubmissionRecoveryStore.setState({ liveSnapshots: {}, persistedSnapshots: {} });
}

beforeEach(resetRecoveryStore);
afterEach(resetRecoveryStore);

describe("failed submission recovery snapshots", () => {
  it("restores the exact prompt, image, and contextual submission data after a reload", async () => {
    const snapshot = makeSnapshot();
    const store = useFailedSubmissionRecoveryStore.getState();
    store.capture(snapshot, [persistedImage()]);
    useFailedSubmissionRecoveryStore.setState({ liveSnapshots: {} });

    const restored = useFailedSubmissionRecoveryStore.getState().get(sourceThreadRef);

    expect(restored).toMatchObject({
      messageId: snapshot.messageId,
      prompt: snapshot.prompt,
      terminalContexts: snapshot.terminalContexts,
      runtimeMode: snapshot.runtimeMode,
      interactionMode: snapshot.interactionMode,
    });
    expect(restored?.images).toHaveLength(1);
    expect(restored?.images[0]).toMatchObject({
      id: "image-original",
      name: "original.png",
      mimeType: "image/png",
      sizeBytes: 1,
    });
    expect(new Uint8Array(await restored!.images[0]!.file.arrayBuffer())).toEqual(
      new Uint8Array([7]),
    );
  });

  it.each([
    ["missing", []],
    [
      "unreadable",
      [
        {
          ...persistedImage(),
          dataUrl: "data:image/png;base64,%",
        },
      ],
    ],
    [
      "over-budget",
      [
        {
          ...persistedImage(),
          dataUrl: `data:image/png;base64,${"A".repeat(2_700_001)}`,
        },
      ],
    ],
  ] as const)("suppresses a reload recovery action when persisted images are %s", (_, images) => {
    const snapshot = makeSnapshot();
    useFailedSubmissionRecoveryStore.getState().capture(snapshot, images);
    useFailedSubmissionRecoveryStore.setState({ liveSnapshots: {} });

    expect(useFailedSubmissionRecoveryStore.getState().get(sourceThreadRef)).toBeNull();
  });
});
