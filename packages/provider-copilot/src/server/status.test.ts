import { assert, it } from "@effect/vitest";
import type { ModelInfo } from "@github/copilot-sdk";

import { gitHubCopilotAuth, gitHubCopilotModels, gitHubCopilotSlashCommands } from "./status.ts";

const model = (overrides: Partial<ModelInfo>) =>
  ({ id: "m", name: "M", capabilities: {}, ...overrides }) as ModelInfo;

it("lists only usable models, each with its own reasoning levels", () => {
  const models = gitHubCopilotModels([
    model({
      id: "fast",
      name: "Fast",
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    }),
    model({ id: "plain", name: "Plain" }),
    model({ id: "blocked", policy: { state: "disabled", terms: "" } }),
  ]);

  assert.deepEqual(
    models.map((entry) => entry.slug),
    ["fast", "plain"],
  );
  const [descriptor] = models[0]?.capabilities?.optionDescriptors ?? [];
  assert.strictEqual(descriptor?.id, "reasoning_effort");
  assert.deepEqual(models[1]?.capabilities?.optionDescriptors, []);
});

it("keeps one /compact, since T3 runs compaction itself", () => {
  const commands = gitHubCopilotSlashCommands([
    { name: "compact", description: "Copilot's" },
    { name: "usage", description: "Show usage" },
  ]);

  assert.deepEqual(
    commands.map((command) => command.name),
    ["compact", "usage"],
  );
});

it("reports the signed-in account", () => {
  assert.deepEqual(gitHubCopilotAuth({ isAuthenticated: true, login: "octocat" }), {
    status: "authenticated",
    label: "octocat",
  });
  assert.deepEqual(gitHubCopilotAuth({ isAuthenticated: false }), { status: "unauthenticated" });
});
