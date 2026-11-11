import { expect } from "e2e";

import { APP_DIR } from "../e2e.config.ts";
import { test, WEB } from "./t3.ts";

test(
  "A quiet completed task does not resurface while its parent environment is unavailable",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("rollout-check");
    await t3.thread({ project, title: "Finished rollout", messages: ["Check the rollout"] });
    await t3.thread({
      project,
      title: "Rollout needs attention",
      messages: ["Check another rollout"],
    });
    await browser.route("http://127.0.0.1:65534/**", (route) => route.abort());

    // The real completed runs get remote-parent metadata only at the HTTP boundary.
    await browser.route("**/api/orchestration/shell*", async (route) => {
      const response = await route.fetch();
      const snapshot = await response.json<{
        threads: Array<{
          title: string;
          status: string;
          lastError?: string;
          delegatedFrom?: { environmentId: string; threadId: string; title: string };
        }>;
      }>();
      for (const thread of snapshot.threads) {
        thread.delegatedFrom = {
          environmentId: "offline-parent",
          threadId: "settled-parent",
          title: "Settled rollout parent",
        };
        if (thread.title === "Rollout needs attention") {
          thread.status = "failed";
          thread.lastError = "Verification needs attention";
        }
      }
      await route.fulfill({ json: snapshot });
    });
    await t3.open();
    await expect(screen.getByText("Finished rollout", { exact: true }).first()).toBeVisible({
      timeout: 120_000,
    });

    await browser.evaluate(
      `async (root) => {
      const { environmentCatalog } = await import("/src/connection/catalog.ts");
      const { appAtomRegistry } = await import("/src/rpc/atomRegistry.ts");
      const { BearerConnectionTarget } = await import("/@fs/" + root + "/packages/client-runtime/src/connection/model.ts");
      const { BearerConnectionRegistration, BearerConnectionProfile, BearerConnectionCredential } = await import("/@fs/" + root + "/packages/client-runtime/src/connection/catalog.ts");
      const fields = { environmentId: "offline-parent", connectionId: "offline-parent", label: "Offline laptop" };
      const result = await environmentCatalog.register.run(appAtomRegistry, new BearerConnectionRegistration({
        target: new BearerConnectionTarget(fields),
        profile: new BearerConnectionProfile({ ...fields, httpBaseUrl: "http://127.0.0.1:65534", wsBaseUrl: "ws://127.0.0.1:65534" }),
        credential: new BearerConnectionCredential({ token: "scenario-only" }),
      }));
      if (result._tag !== "Success") throw new Error("Could not register the offline fixture");
    }`,
      APP_DIR,
    );
    await expect(
      screen.getByText("Rollout needs attention", { exact: true }).first(),
    ).toBeVisible();
    await app.screenshot("offline-parent");
    await expect(screen.getByText("Finished rollout", { exact: true }).first()).toBeHidden();
  },
);
