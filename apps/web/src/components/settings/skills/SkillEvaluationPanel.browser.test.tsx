import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SkillEvalTaskId,
  type SkillEvalTask,
  type SkillModelCell,
  type SkillVariantRule,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../../test/render";
import { SkillEvaluationPanel } from "./SkillEvaluationPanel";

const projectId = ProjectId.make("project:skill-eval");
const taskId = SkillEvalTaskId.make("task:off-rule");
const driver = ProviderDriverKind.make("claudeAgent");
const rule: SkillVariantRule = {
  ruleId: "rule:off",
  skillName: "review",
  driver,
  model: "claude-fable-5-1",
  mode: "off",
  body: null,
  enabled: true,
  forkedFromRuleId: null,
  revision: 4,
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
  deletedAt: null,
};
const cell: SkillModelCell = {
  driver,
  model: "claude-fable-5-1",
  delivery: "developer-context",
  gating: "instruction",
  effectiveMode: "off",
  ruleId: rule.ruleId,
  verdict: {
    verdict: "not-enough-data",
    reason: "no-evaluations",
    effect: null,
    ciLow: null,
    ciHigh: null,
    pAdjusted: null,
    nTasks: 0,
  },
  observational: {
    turns: 0,
    activationRate: null,
    completionRate: null,
    completionCiLow: null,
    completionCiHigh: null,
    revertRate: null,
    revertCiLow: null,
    revertCiHigh: null,
    toolFailureRate: null,
    medianTokens: null,
    medianDurationMs: null,
    confounded: true,
  },
};
const task: SkillEvalTask = {
  taskId,
  skillName: "review",
  projectId,
  promptType: "direct",
  prompt: "Review this change.",
  rubric: "Prefer the more accurate review.",
  expectation: "either",
  baseRef: null,
  sourceRunId: null,
  createdAt: "2026-10-29T00:00:00.000Z",
  archivedAt: null,
};

it("starts an off-rule evaluation with the off rule as treatment", async () => {
  const onControlRun = vi.fn();
  // This isolated settings panel does not navigate, so a router would add unrelated setup.
  await using screen = await render(
    <SkillEvaluationPanel
      skillName="review"
      cell={cell}
      rules={[rule]}
      tasks={[task]}
      runs={[]}
      runDetail={null}
      runDetailPending={false}
      runDetailError={null}
      selectedRunId={null}
      projects={[{ id: projectId, title: "Project" }]}
      candidateForProject={() => ({
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-fable-5-1",
      })}
      canMutateTasks
      canControlRuns
      taskBusy={false}
      runBusy={false}
      onSelectRun={() => undefined}
      onRefreshRunDetail={() => undefined}
      onMutateTask={() => undefined}
      onControlRun={onControlRun}
    />,
    { router: false },
  );

  await userEvent.click(screen.getByRole("button", { name: "Start evaluation" }));
  const dialog = page.getByRole("dialog");
  await userEvent.fill(dialog.getByLabelText("Repeats"), "7");
  await userEvent.click(dialog.getByRole("button", { name: "Cancel", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Start evaluation" }));
  await expect.element(dialog.getByLabelText("Repeats")).toHaveValue(3);
  await expect.element(dialog.getByLabelText("Judge samples")).toHaveValue(3);
  await userEvent.click(dialog.getByRole("button", { name: "Start run" }));

  expect(onControlRun).toHaveBeenCalledWith({
    action: "start",
    config: {
      skillName: "review",
      projectId,
      candidate: {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-fable-5-1",
      },
      arms: [
        { armId: "base", label: "Base", kind: "base", role: "control" },
        {
          armId: "off",
          label: "Current off rule",
          kind: "off",
          ruleId: rule.ruleId,
          role: "treatment",
        },
      ],
      repeats: 3,
      judge: null,
      judgeSamples: 3,
      concurrency: 1,
      taskIds: [taskId],
      variantRevisions: { [rule.ruleId]: 4 },
    },
  });
});
