import * as Effect from "effect/Effect";
import type { FileUploadActionInput, FileUploadInput } from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as FileUploadService from "../../FileUploadService.ts";
import { FileUploadToolkit, GenericActionToolkit } from "./tools.ts";

const upload = (input: FileUploadInput) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    yield* McpInvocationContext.requireMcpCapability("file-upload");
    const service = yield* FileUploadService.FileUploadService;
    return yield* service.upload(input, scope);
  });

const handlers = { "file-upload": upload } satisfies Parameters<
  typeof FileUploadToolkit.toLayer
>[0];

export const FileUploadToolkitHandlersLive = FileUploadToolkit.toLayer(handlers);

const invoke = (input: FileUploadActionInput) => upload(input.input);

const genericActionHandlers = { action: invoke } satisfies Parameters<
  typeof GenericActionToolkit.toLayer
>[0];

export const GenericActionToolkitHandlersLive = GenericActionToolkit.toLayer(genericActionHandlers);
