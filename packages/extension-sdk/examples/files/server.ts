import type { ServerExtension } from "@t3tools/extension-sdk/environment";
import { filePresentationApi } from "@t3tools/extension-sdk/catalogue";
import { infoApi } from "./api.js";

export default {
  apis: [
    {
      id: filePresentationApi.definition.id,
      methods: [
        {
          name: "open",
          invoke(input, session) {
            session.signal.throwIfAborted();
            const relativePath = (input as { relativePath: string }).relativePath;
            return {
              surfaceId: "example.files/view",
              placement: "side-panel",
              restoreState: { relativePath },
            };
          },
        },
      ],
    },
    {
      id: infoApi.definition.id,
      methods: [
        {
          name: "describe",
          invoke() {
            return { title: "Independent Files provider", readOnly: true };
          },
        },
      ],
    },
  ],
} satisfies Omit<ServerExtension, "tools">;
