import { defineExtension, requireApi, useApiRead } from "@t3tools/extension-sdk/authoring";
import { greetingApi } from "../api-provider/api.js";

export default defineExtension({
  id: "example.greeting-consumer",
  version: "1.0.0",
  requires: [requireApi(greetingApi)],
  dependencies: [
    {
      pluginId: "example.greeting",
      versionRange: "^1.0.0",
      apis: [requireApi(greetingApi)],
    },
  ],
  surfaces: [
    {
      name: "view",
      title: "Greeting consumer",
      scope: "project",
      createView(host, session) {
        return {
          renderer: function Greeting() {
            const result = useApiRead(host, session, greetingApi, "greet", {});
            return host.React.createElement(
              "p",
              { "aria-label": "Greeting consumer" },
              result.status === "ready"
                ? result.value.message
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
