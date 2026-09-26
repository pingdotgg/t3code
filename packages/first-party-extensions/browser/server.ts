import type { ServerExtension } from "@t3tools/extension-sdk/environment";
import { filePresentationApi } from "@t3tools/extension-sdk/catalogue";

import { isBrowserPreviewFile } from "./viewModel.js";

export default {
  tools: [],
  apis: [
    {
      id: filePresentationApi.definition.id,
      methods: [
        {
          name: "open",
          invoke(input, session) {
            session.signal.throwIfAborted();
            const value = input as { readonly relativePath?: unknown };
            if (typeof value.relativePath !== "string")
              throw new Error("Expected a workspace-relative path");
            const relativePath = value.relativePath;
            if (!isBrowserPreviewFile(relativePath))
              throw new Error(
                `Not a browser-previewable file: ${relativePath} (the browser surface accepts .html/.htm/.pdf only)`,
              );
            return {
              surfaceId: "t3.browser/view",
              placement: "side-panel",
              restoreState: { relativePath },
            };
          },
        },
      ],
    },
  ],
} satisfies ServerExtension;
