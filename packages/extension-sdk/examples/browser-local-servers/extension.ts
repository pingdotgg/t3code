import { defineExtension, requireApi } from "@t3tools/extension-sdk/authoring";
import { browserLocalServersApi } from "@t3tools/extension-sdk/catalogue";

export default defineExtension({
  id: "example.browser-local-servers",
  version: "1.0.0",
  requires: [requireApi(browserLocalServersApi)],
  provides: [{ ...browserLocalServersApi.definition, id: "example.browser-local-servers/read" }],
  serverEntry: "server.ts",
});
