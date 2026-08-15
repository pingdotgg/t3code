import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Composer attachments upload the moment they are attached, before any thread
 * exists. `createUploadUrl` mints a short-lived signed URL (the token in the
 * URL carries authorization, so the byte PUT needs no headers of its own);
 * `remove` releases an attachment the user cancelled or deleted.
 */
export const attachmentEnvironment = {
  createUploadUrl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:attachments:create-upload-url",
    tag: WS_METHODS.attachmentsCreateUploadUrl,
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:attachments:delete",
    tag: WS_METHODS.attachmentsDelete,
  }),
};
