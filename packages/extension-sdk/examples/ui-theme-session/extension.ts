import { defineExtension, requireApi } from "@t3tools/extension-sdk/authoring";
import { uiThemeApi } from "@t3tools/extension-sdk/catalogue";

export default defineExtension({
  id: "example.ui-theme-session",
  version: "1.0.0",
  requires: [requireApi(uiThemeApi)],
  provides: [
    {
      id: "example.ui-theme-session/theme",
      version: "1.0.0",
      methods: [
        {
          name: "getState",
          effect: "read",
          requiredGrants: ["t3.ui/theme.read"],
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              clientConnectionId: { type: "string", minLength: 1, maxLength: 160 },
            },
          },
          outputSchema: { type: "object" },
        },
        {
          name: "applySessionTheme",
          effect: "write",
          requiredGrants: ["t3.ui/theme.write"],
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["theme"],
            properties: {
              theme: { type: "string", minLength: 1, maxLength: 160 },
              clientConnectionId: { type: "string", minLength: 1, maxLength: 160 },
            },
          },
          outputSchema: {
            type: "object",
            required: ["applied"],
            properties: { applied: { type: "boolean" } },
          },
        },
      ],
      streams: [],
    },
  ],
  serverEntry: "server.ts",
});
