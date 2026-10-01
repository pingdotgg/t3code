import { defineExtension, requireApi } from "@t3tools/extension-sdk/authoring";
import { browserProfilesApi } from "@t3tools/extension-sdk/catalogue";

/**
 * Declares `t3.browser/profiles` and nothing else. Which of its four
 * capabilities work is decided by the installation's grants alone.
 */
export default defineExtension({
  id: "example.browser-profiles",
  version: "1.0.0",
  requires: [requireApi(browserProfilesApi)],
  serverEntry: "server.ts",
});
