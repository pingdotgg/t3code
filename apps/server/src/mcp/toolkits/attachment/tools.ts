import {
  AttachmentMcpDiscardUploadInput,
  AttachmentMcpDiscardUploadResult,
  AttachmentMcpFailure,
  AttachmentMcpPrepareUploadInput,
  AttachmentMcpPrepareUploadResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import { AttachmentMcpService } from "../../AttachmentMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, AttachmentMcpService];

export const AttachmentPrepareUploadTool = Tool.make("t3_attachment_prepare_upload", {
  description:
    "Prepare a bounded image or file attachment for a T3 thread message. Upload exactly sizeBytes with HTTP PUT to the returned environment-relative signed URL, then pass the returned attachment metadata to t3_thread_start, create_threads, or t3_thread_send. This tool does not read host files or upload bytes itself; each call issues a new pending attachment id.",
  parameters: AttachmentMcpPrepareUploadInput,
  success: AttachmentMcpPrepareUploadResult,
  failure: AttachmentMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Prepare a T3 attachment upload")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const AttachmentDiscardUploadTool = Tool.make("t3_attachment_discard_upload", {
  description:
    "Discard a pending T3 attachment upload using its id and signed uploadRelativeUrl from t3_attachment_prepare_upload. This is idempotent while the signed URL remains valid and cannot delete an attachment already claimed by a thread.",
  parameters: AttachmentMcpDiscardUploadInput,
  success: AttachmentMcpDiscardUploadResult,
  failure: AttachmentMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Discard a pending T3 attachment")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const AttachmentToolkit = Toolkit.make(
  AttachmentPrepareUploadTool,
  AttachmentDiscardUploadTool,
);
