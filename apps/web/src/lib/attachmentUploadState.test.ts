import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { attachmentUploadBlockReason } from "./attachmentUploadState";

const environmentId = EnvironmentId.make("environment-1");

describe("attachmentUploadBlockReason", () => {
  it("does not accept an upload from another environment", () => {
    expect(
      attachmentUploadBlockReason({
        imageIds: ["image-1"],
        environmentId,
        uploadsByImageId: {
          "image-1": {
            status: "ready",
            environmentId: EnvironmentId.make("environment-2"),
            attachmentId: "pending-1",
          },
        },
      }),
    ).toBe("Attachment still uploading");
  });
});
