import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type BotProfile } from "@t3tools/contracts";

import { botRunSource, botTurnPolicy } from "./botTurnPolicy.ts";

const bot: BotProfile = {
  threadId: ThreadId.make("bot:policy"),
  projectId: ProjectId.make("project"),
  state: "active",
  revision: 1,
  name: "Policy test",
  role: "",
  description: "",
  icon: "",
  color: "#6366f1",
  instructions: "Summarize recent changes.",
  access: { writeSources: ["scheduled"], handoffProjects: [] },
};

const basePolicy = {
  runtimeMode: "full-access",
  cwd: "/work",
  interactionMode: "default",
} as const;

it("limits workspace writes to the granted trigger and the managed ceiling", () => {
  const direct = { id: "message", createdBy: "user", creationSource: "web" };
  const scheduled = {
    ...direct,
    id: "scheduled-task-message:task:1:scheduled",
    scheduledTaskId: "task",
  };
  const webhook = { ...scheduled, id: "scheduled-task-message:task:webhook:delivery" };
  assert.equal(botRunSource(webhook), "webhook");

  const directPolicy = botTurnPolicy(bot, basePolicy, direct);
  assert.deepEqual(directPolicy.sandboxPolicy, { type: "readOnly" });
  assert.equal(directPolicy.approvalPolicy, "untrusted");
  assert.match(directPolicy.botInstructions?.join("") ?? "", /Summarize recent changes\./);

  const allowed = botTurnPolicy(bot, basePolicy, scheduled);
  assert.deepEqual(allowed.sandboxPolicy, {
    type: "workspaceWrite",
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true,
  });
  assert.equal(allowed.approvalPolicy, "never");
  const external = botTurnPolicy(bot, basePolicy, webhook);
  assert.deepEqual(external.sandboxPolicy, { type: "readOnly" });
  assert.equal(external.botWorkspaceProfile, "read");
  assert.equal(botTurnPolicy(bot, basePolicy, direct, true).botWorkspaceProfile, "read");
  assert.deepEqual(
    botTurnPolicy(bot, { ...basePolicy, maxRuntimeMode: "approval-required" }, scheduled)
      .sandboxPolicy,
    { type: "readOnly" },
  );
});
