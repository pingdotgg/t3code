import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { type ComposerImageAttachment, useComposerDraftStore } from "~/composerDraftStore";
import {
  copiedComposerAttachmentFile,
  rememberCopiedComposerAttachments,
} from "./copiedComposerAttachments";

const environmentId = EnvironmentId.make("environment-local");
const sourceThread = scopeThreadRef(environmentId, ThreadId.make("source-thread"));

function draftImage(id: string, bytes: number[]): ComposerImageAttachment {
  const file = new File([new Uint8Array(bytes)], "shot.png", { type: "image/png" });
  return {
    type: "image",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: `blob:${id}`,
    file,
  };
}

describe("copied composer attachments", () => {
  afterEach(() => {
    rememberCopiedComposerAttachments(environmentId, new Map());
    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    vi.restoreAllMocks();
  });

  it("keeps copied bytes readable after the source draft lets go of the image", async () => {
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const image = draftImage("still-uploading", [1, 2, 3]);
    const store = useComposerDraftStore.getState();
    store.addImages(sourceThread, [image]);
    // A copy before the upload finishes carries the draft id in place of a server id.
    rememberCopiedComposerAttachments(environmentId, new Map([[image.id, image.file]]));

    store.removeImage(sourceThread, image.id);
    store.clearComposerContent(sourceThread);

    const draft = useComposerDraftStore.getState().draftsByThreadKey;
    expect(Object.values(draft).flatMap((entry) => entry.images)).toEqual([]);
    const copied = copiedComposerAttachmentFile(environmentId, image.id);
    expect(copied).toBe(image.file);
    expect([...new Uint8Array(await copied!.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("only answers for the latest copy from the same environment", () => {
    const first = draftImage("first", [1]);
    const second = draftImage("second", [2]);
    rememberCopiedComposerAttachments(environmentId, new Map([["pending-1", first.file]]));
    expect(copiedComposerAttachmentFile(EnvironmentId.make("other"), "pending-1")).toBeUndefined();

    rememberCopiedComposerAttachments(environmentId, new Map([["pending-2", second.file]]));
    expect(copiedComposerAttachmentFile(environmentId, "pending-1")).toBeUndefined();
    expect(copiedComposerAttachmentFile(environmentId, "pending-2")).toBe(second.file);
  });
});
