import { createQuickChatAttachmentStorage } from "@t3tools/client-runtime/operations/quickChats";

export const quickChatAttachmentStorage = createQuickChatAttachmentStorage({
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: (key) => window.localStorage.removeItem(key),
});
