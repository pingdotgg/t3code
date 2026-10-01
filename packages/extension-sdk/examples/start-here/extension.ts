import { defineExtension, requireApi, useApiRead } from "@t3tools/extension-sdk/authoring";
import { workspaceFilesApi } from "@t3tools/extension-sdk/catalogue";

export default defineExtension({
  id: "example.readme",
  version: "1.0.0",
  requires: [requireApi(workspaceFilesApi)],
  surfaces: [
    {
      name: "view",
      title: "Workspace README",
      scope: "project",
      createView(host, session) {
        return {
          renderer: function Readme() {
            const result = useApiRead(host, session, workspaceFilesApi, "readText", {
              relativePath: "README.md",
            });
            return host.React.createElement(
              "pre",
              {
                "aria-label": "Workspace README",
                style: { padding: 12, whiteSpace: "pre-wrap", overflow: "auto", maxHeight: "100%" },
              },
              result.status === "ready"
                ? result.value.contents + (result.value.truncated ? "\n… (truncated)" : "")
                : result.status === "unavailable"
                  ? result.error
                  : "Loading…",
            );
          },
        };
      },
    },
  ],
});
