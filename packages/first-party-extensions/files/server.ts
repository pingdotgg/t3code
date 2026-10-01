import type { ServerExtension } from "@t3tools/extension-sdk/environment";
import { filePresentationApi } from "@t3tools/extension-sdk/catalogue";
import { validateWorkspaceReadTextInput } from "@t3tools/extension-sdk/workspace";

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
            const value = input as { readonly relativePath?: unknown; readonly line?: unknown };
            const relativePath =
              value.relativePath === ""
                ? ""
                : validateWorkspaceReadTextInput({
                    relativePath: value.relativePath,
                  }).relativePath;
            // 1.1.0: a file link's line; the view reveals it once it opens.
            const line =
              relativePath !== "" && Number.isInteger(value.line) && (value.line as number) >= 1
                ? (value.line as number)
                : undefined;
            return {
              surfaceId: "t3.files/view",
              placement: "side-panel",
              restoreState: { relativePath, ...(line === undefined ? {} : { line }) },
            };
          },
        },
      ],
    },
  ],
} satisfies ServerExtension;
