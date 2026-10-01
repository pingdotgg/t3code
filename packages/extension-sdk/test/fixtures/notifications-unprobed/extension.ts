import { defineExtension, requireApi } from "@t3tools/extension-sdk/authoring";
import { bindApi } from "@t3tools/extension-sdk/capabilities";
import { uiNotificationsApi } from "@t3tools/extension-sdk/catalogue";

// Declares the default ^1.0.0 and sends a 1.1.0 member without probing.
export default defineExtension({
  id: "fixture.notifications-unprobed",
  version: "1.0.0",
  requires: [requireApi(uiNotificationsApi)],
  surfaces: [
    {
      name: "view",
      title: "Unprobed keepOpen",
      scope: "project",
      capabilities: ["t3.ui/notify"],
      createView(host, session) {
        (globalThis as { unprobedNotify?: Promise<unknown> }).unprobedNotify = bindApi(
          uiNotificationsApi,
          host,
          session.context,
        ).invoke(
          "notify",
          {
            severity: "success",
            title: "Capture",
            actions: [{ id: "copy", label: "Copy", keepOpen: true }],
          },
          session.signal,
        );
        return { renderer: () => null };
      },
    },
  ],
});
