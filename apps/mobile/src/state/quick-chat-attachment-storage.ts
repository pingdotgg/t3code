import { createQuickChatAttachmentStorage } from "@t3tools/client-runtime/operations/quickChats";
import { Directory, File, Paths } from "expo-file-system";
import { writeFileAtomically } from "../lib/atomic-file";

function attachmentFile(key: string) {
  const directory = new Directory(Paths.document, "quick-chat-attachments");
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, `${encodeURIComponent(key)}.json`);
}

export const quickChatAttachmentStorage = createQuickChatAttachmentStorage({
  getItem: (key) => {
    const file = attachmentFile(key);
    return file.exists ? file.textSync() : null;
  },
  setItem: (key, value) => writeFileAtomically(attachmentFile(key), value),
  removeItem: (key) => {
    const file = attachmentFile(key);
    if (file.exists) file.delete();
  },
});
