import { defineExtension, requireApi } from "@t3tools/extension-sdk/authoring";
import { providersStatusApi } from "@t3tools/extension-sdk/catalogue";

export default defineExtension({
  id: "example.providers-status",
  version: "1.0.0",
  requires: [requireApi(providersStatusApi)],
  provides: [{ ...providersStatusApi.definition, id: "example.providers-status/read" }],
  serverEntry: "server.ts",
});
