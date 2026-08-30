import * as Effect from "effect/Effect";

import { AttachmentMcpService } from "../../AttachmentMcpService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { AttachmentToolkit } from "./tools.ts";

const handlers = {
  t3_attachment_prepare_upload: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* AttachmentMcpService;
      return yield* service.prepareUpload(scope, input);
    }),
  t3_attachment_discard_upload: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* AttachmentMcpService;
      return yield* service.discardUpload(scope, input);
    }),
} satisfies Parameters<typeof AttachmentToolkit.toLayer>[0];

export const AttachmentToolkitHandlersLive = AttachmentToolkit.toLayer(handlers);
