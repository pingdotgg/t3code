import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "MCP launches enter Working without an idle Inbox row",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("mcp-launch");
    await t3.open();
    await expect(screen.getByRole("navigation", "Threads")).toBeVisible();
    await browser.evaluate(`(() => {
      const observations = [];
      const sidebar = document.querySelector('[aria-label="Threads"]');
      if (sidebar === null) throw new Error("The sidebar is missing.");
      const observer = new MutationObserver(() => {
        for (const row of sidebar.querySelectorAll("[data-sidebar-row]")) {
          const label = row.getAttribute("aria-label");
          if (label?.startsWith("MCP launch proof ") && !label.includes(", Done,")) {
            observations.push(label);
          }
        }
      });
      observer.observe(sidebar, { subtree: true, childList: true, attributes: true });
      Object.assign(window, { mcpLaunchProof: { observations, observer } });
      return null;
    })()`);

    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        t3.thread({
          project,
          title: `MCP launch proof ${index + 1}`,
          model: "todo-list",
          messages: ["go"],
        }),
      ),
    );

    await expect(
      browser.locator('[data-sidebar-row][aria-label^="MCP launch proof "][aria-label*=", Done,"]'),
    ).toHaveCount(16);
    const idleRows = await browser.evaluate(`(() => {
      const proof = window.mcpLaunchProof;
      proof.observer.disconnect();
      return proof.observations;
    })()`);
    await app.screenshot("mcp-launches");
    expect(idleRows).toEqual([]);
  },
);
