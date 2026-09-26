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
            const value = input as { readonly relativePath?: unknown };
            const relativePath =
              value.relativePath === ""
                ? ""
                : validateWorkspaceReadTextInput({
                    relativePath: value.relativePath,
                  }).relativePath;
            return {
              surfaceId: "t3.files/view",
              placement: "side-panel",
              restoreState: { relativePath },
            };
          },
        },
      ],
    },
  ],
} satisfies ServerExtension;
