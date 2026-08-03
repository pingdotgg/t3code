import {
  FileUploadActionInput,
  FileUploadError,
  FileUploadInput,
  FileUploadResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as FileUploadService from "../../FileUploadService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  FileUploadService.FileUploadService,
];

export const FileUploadTool = Tool.make("file-upload", {
  description:
    "Upload one image or video from the active thread workspace to configured immutable public object storage. The path must be workspace-relative; content type is detected from file bytes and is not trusted from the extension.",
  parameters: FileUploadInput,
  success: FileUploadResult,
  failure: FileUploadError,
  dependencies,
})
  .annotate(Tool.Title, "Upload file")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const FileUploadToolkit = Toolkit.make(FileUploadTool);

export const GenericActionTool = Tool.make("action", {
  description:
    "Invoke an authenticated runtime action. The supported action is file-upload; its input must be workspace-relative and is validated from file bytes.",
  parameters: FileUploadActionInput,
  success: FileUploadResult,
  failure: FileUploadError,
  dependencies,
})
  .annotate(Tool.Title, "Invoke runtime action")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const GenericActionToolkit = Toolkit.make(GenericActionTool);
