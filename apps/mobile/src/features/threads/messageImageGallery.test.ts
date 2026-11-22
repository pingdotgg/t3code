import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { messageImageGallery } from "./messageImageGallery";

it("gives every sent image page its own share source", () => {
  const environmentId = EnvironmentId.make("host");
  const images = messageImageGallery(
    {
      text: "",
      attachments: [
        { type: "image", id: "first", name: "photo.png", mimeType: "image/png", sizeBytes: 1 },
        { type: "file", id: "second", name: "photo.png", mimeType: "image/png", sizeBytes: 1 },
        { type: "file", id: "pdf", name: "notes.pdf", mimeType: "application/pdf", sizeBytes: 1 },
      ],
    },
    { environmentId, threadId: ThreadId.make("thread"), workspaceRoot: null },
  );

  expect(images.map((image) => image.actionsSource)).toEqual(
    ["first", "second"].map((attachmentId) => ({
      name: "photo.png",
      mimeType: "image/png",
      environmentId,
      resource: {
        _tag: "attachment",
        attachmentId,
        fileName: "photo.png",
        mimeType: "image/png",
      },
    })),
  );
});
