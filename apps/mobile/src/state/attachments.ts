import { createAttachmentEnvironmentAtoms } from "@t3tools/client-runtime/state/attachments";

import { connectionAtomRuntime } from "../connection/runtime";

export const attachmentEnvironment = createAttachmentEnvironmentAtoms(connectionAtomRuntime);
