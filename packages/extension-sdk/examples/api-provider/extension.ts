import { defineExtension } from "@t3tools/extension-sdk/authoring";
import { greetingApi } from "./api.js";

export default defineExtension({
  id: "example.greeting",
  version: "1.0.0",
  provides: [greetingApi.definition],
  serverEntry: "server.ts",
});
