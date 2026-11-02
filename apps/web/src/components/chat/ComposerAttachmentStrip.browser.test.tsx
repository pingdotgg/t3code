import { EnvironmentId } from "@t3tools/contracts";
import { Profiler } from "react";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { DraftId, type ComposerFileAttachment } from "../../composerDraftStore";
import { useAttachmentUploads, useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import {
  attachmentUploadBlockReason,
  type AttachmentUploadState,
} from "../../lib/attachmentUploadState";
import { ComposerAttachmentFileList } from "./ComposerAttachmentStrip";

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");

function makeFile(id: string): ComposerFileAttachment {
  const file = new File([new Uint8Array([1, 2, 3])], `${id}.pdf`, { type: "application/pdf" });
  return {
    type: "file",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
  };
}

function setUploads(uploadsByImageId: Record<string, AttachmentUploadState>) {
  return act(() => useAttachmentUploadStore.setState({ uploadsByImageId }));
}

function FileList({ files }: { files: ReadonlyArray<ComposerFileAttachment> }) {
  return (
    <ComposerAttachmentFileList
      files={files}
      resolvedTheme="light"
      supportsAttachmentUploads
      maxFileAttachmentBytes={1024}
      fileStagingLimit={1024}
      environmentId={environmentId}
      attachmentDraftTarget={DraftId.make("draft-1")}
      canOperateThread
      onPreviewFile={() => {}}
      onRemoveFile={() => {}}
    />
  );
}

function BlockReason({ ids }: { ids: ReadonlyArray<string> }) {
  const uploadsByImageId = useAttachmentUploads(ids.map((id) => ({ id })));
  return (
    <output>
      {attachmentUploadBlockReason({ imageIds: ids, uploadsByImageId, environmentId }) ?? "clear"}
    </output>
  );
}

describe("composer upload status selection", () => {
  it("re-renders only for uploads the file list owns", async () => {
    await setUploads({});
    let ownerCommits = 0;
    let emptyCommits = 0;
    const file = makeFile("owned");
    const tree = (files: ReadonlyArray<ComposerFileAttachment>) => (
      <>
        <Profiler id="owner" onRender={() => (ownerCommits += 1)}>
          <FileList files={files} />
        </Profiler>
        <Profiler id="empty" onRender={() => (emptyCommits += 1)}>
          <FileList files={[]} />
        </Profiler>
      </>
    );
    await using screen = await render(tree([file]));
    const ownerBaseline = ownerCommits;
    const emptyBaseline = emptyCommits;

    for (let step = 1; step <= 20; step += 1) {
      await setUploads({
        unrelated: { status: "uploading", environmentId, progress: step * 0.05 },
      });
    }
    expect(ownerCommits - ownerBaseline).toBe(0);
    expect(emptyCommits - emptyBaseline).toBe(0);

    const unrelated = useAttachmentUploadStore.getState().uploadsByImageId;
    await setUploads({
      ...unrelated,
      owned: { status: "uploading", environmentId, progress: 0.4 },
    });
    await expect.element(screen.getByText("40%")).toBeInTheDocument();
    expect(ownerCommits - ownerBaseline).toBe(1);
    expect(emptyCommits - emptyBaseline).toBe(0);

    await setUploads({ owned: { status: "failed", environmentId, reason: "Upload failed" } });
    await expect
      .element(screen.getByRole("button", { name: "Retry upload for owned.pdf" }))
      .toBeInTheDocument();

    await setUploads({});
    await expect
      .element(screen.getByRole("button", { name: "Retry upload for owned.pdf" }))
      .not.toBeInTheDocument();

    await setUploads({ other: { status: "uploading", environmentId, progress: 0.7 } });
    await screen.rerender(tree([makeFile("other")]));
    await expect.element(screen.getByText("70%")).toBeInTheDocument();
  });

  it("keeps the status details the send block depends on", async () => {
    await setUploads({});
    await using screen = await render(<BlockReason ids={["owned"]} />);
    const output = screen.getByRole("status");
    await expect.element(output).toHaveTextContent("Attachment still uploading");

    const ready = { status: "ready", environmentId, attachmentId: "pending-1" } as const;
    await setUploads({ owned: ready });
    await expect.element(output).toHaveTextContent("clear");

    await setUploads({
      owned: { status: "ready", environmentId: otherEnvironmentId, attachmentId: "pending-2" },
    });
    await expect.element(output).toHaveTextContent("Attachment still uploading");

    await setUploads({
      owned: { status: "uploading", environmentId, progress: 0.1, previous: ready },
    });
    await expect.element(output).toHaveTextContent("Attachment still uploading");

    await setUploads({ owned: { status: "failed", environmentId, reason: "Upload failed" } });
    await expect.element(output).toHaveTextContent("clear");

    await setUploads({
      owned: { status: "failed", environmentId: otherEnvironmentId, reason: "Upload failed" },
    });
    await expect.element(output).toHaveTextContent("Attachment still uploading");

    await setUploads({});
    await expect.element(output).toHaveTextContent("Attachment still uploading");
  });
});
