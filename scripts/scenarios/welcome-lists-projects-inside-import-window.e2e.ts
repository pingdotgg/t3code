// @effect-diagnostics nodeBuiltinImport:off - the scenario writes a Codex history and its settings.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect } from "e2e";
import * as DateTime from "effect/DateTime";

import { T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

const rollout = (id: string, cwd: string, timestamp: string) =>
  [
    { timestamp, type: "session_meta", payload: { id, cwd } },
    {
      timestamp,
      type: "event_msg",
      payload: { type: "user_message", message: `Work on ${NodePath.basename(cwd)}` },
    },
    {
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");

test(
  "The Welcome page lists only projects with conversations inside the import window",
  WEB,
  async ({ t3, app, screen }) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-scenario-window-"));
    const codexHome = NodePath.join(root, "codex");
    const settingsPath = NodePath.join(T3_HOME, "userdata/settings.json");
    const originalSettings = await NodeFSP.readFile(settingsPath, "utf8");
    try {
      const now = await runPromise(DateTime.now);
      for (const [project, ages] of [
        ["recent-app", [2, 45]],
        ["archived-app", [60, 90]],
      ] as const) {
        const workspace = NodePath.join(root, project);
        await NodeFSP.mkdir(workspace);
        await runPromise(run("git", ["init", "--quiet"], { cwd: workspace }));
        for (const ageDays of ages) {
          const at = DateTime.subtract(now, { days: ageDays });
          const timestamp = DateTime.formatIso(at);
          const seconds = DateTime.toEpochMillis(at) / 1000;
          const id = `${project}-${ageDays}`;
          const day = timestamp.slice(0, 10).split("-");
          const file = NodePath.join(codexHome, "sessions", ...day, `rollout-${id}.jsonl`);
          await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
          await NodeFSP.writeFile(file, rollout(id, workspace, timestamp));
          await NodeFSP.utimes(file, seconds, seconds);
        }
      }
      const settings = JSON.parse(originalSettings);
      settings.providerInstances.codex = {
        ...settings.providerInstances.codex,
        enabled: true,
        config: { ...settings.providerInstances.codex.config, homePath: codexHome },
      };
      await NodeFSP.writeFile(settingsPath, JSON.stringify(settings));

      await t3.open("/welcome");
      const reviewAll = screen.getByRole("button", /^Review all/);
      await expect(reviewAll).toBeVisible({ timeout: 60_000 });
      await reviewAll.tap();
      await expect(screen.getByText("recent-app").first()).toBeVisible({ timeout: 60_000 });
      await app.screenshot("project-list");

      await expect(screen.getByText("archived-app")).toHaveCount(0);
    } finally {
      await NodeFSP.writeFile(settingsPath, originalSettings);
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
