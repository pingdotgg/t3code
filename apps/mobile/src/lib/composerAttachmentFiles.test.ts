import { describe, expect, it } from "vite-plus/test";

import {
  composerAttachmentFileReferenceKey,
  resolveOwnedComposerAttachmentFileUri,
} from "./composerAttachmentFiles";

const OLD_CONTAINER = "11111111-1111-4111-8111-111111111111";
const CURRENT_CONTAINER = "22222222-2222-4222-8222-222222222222";
const FILE_NAME = "33333333-3333-4333-8333-333333333333-report%20%252F%20%23.pdf";

describe("owned attachment paths", () => {
  it.each([
    "file:///var/mobile/Containers/Data/Application/",
    "file:///Users/dev/Library/Developer/CoreSimulator/Devices/device/data/Containers/Data/Application/",
  ])("resolves saved files after an iOS container move under %s", (prefix) => {
    const oldUri = `${prefix}${OLD_CONTAINER}/Documents/t3-composer-attachments/${FILE_NAME}`;
    const documentUri = `${prefix}${CURRENT_CONTAINER}/Documents/`;
    const currentUri = `${documentUri}t3-composer-attachments/${FILE_NAME}`;

    expect(resolveOwnedComposerAttachmentFileUri(oldUri, documentUri)).toBe(currentUri);
    expect(composerAttachmentFileReferenceKey(oldUri)).toBe(
      composerAttachmentFileReferenceKey(currentUri),
    );
  });

  it("recognizes the private/var alias without changing the stored filename", () => {
    const oldUri = `file:///private/var/mobile/Containers/Data/Application/${OLD_CONTAINER}/Documents/t3-composer-attachments/${FILE_NAME}`;
    const documentUri = `file:///var/mobile/Containers/Data/Application/${CURRENT_CONTAINER}/Documents/`;
    const currentUri = `${documentUri}t3-composer-attachments/${FILE_NAME}`;

    expect(resolveOwnedComposerAttachmentFileUri(oldUri, documentUri)).toBe(currentUri);
    expect(composerAttachmentFileReferenceKey(oldUri)).toBe(
      composerAttachmentFileReferenceKey(currentUri),
    );
  });

  it.each([
    `file:///private/var/mobile/Containers/Shared/FileProvider/other/Documents/t3-composer-attachments/${FILE_NAME}`,
    `file:///var/mobile/Containers/Shared/AppGroup/other/t3-composer-attachments/${FILE_NAME}`,
    `file:///var/mobile/Containers/Data/Application/${OLD_CONTAINER}/Documents/report.pdf`,
    `file:///var/mobile/Containers/Data/Application/${OLD_CONTAINER}/Documents/t3-composer-attachments/report.pdf`,
    `file:///downloads/t3-composer-attachments/${FILE_NAME}`,
    `content://shared/t3-composer-attachments/${FILE_NAME}`,
    `https://example.com/t3-composer-attachments/${FILE_NAME}`,
    `file:///var/mobile/Containers/Data/Application/${OLD_CONTAINER}/Documents/t3-composer-attachments/..%2F..%2Fsender.pdf`,
    `file:///var/mobile/Containers/Data/Application/${OLD_CONTAINER}/Documents/t3-composer-attachments/${FILE_NAME}%2Fnested.pdf`,
  ])("does not rebase an external or escaped path: %s", (uri) => {
    expect(
      resolveOwnedComposerAttachmentFileUri(
        uri,
        `file:///var/mobile/Containers/Data/Application/${CURRENT_CONTAINER}/Documents/`,
      ),
    ).toBeNull();
  });
});
