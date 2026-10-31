import {
  ProviderDriverKind,
  type SkillModelCell,
  type SkillVariantMutateInput,
  type SkillVariantRule,
} from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { SkillVariantActions, SkillVariantPanel } from "./SkillVariantPanel";

const BASE_CELL: SkillModelCell = {
  driver: ProviderDriverKind.make("claude"),
  model: "claude-fable-5-1",
  delivery: "developer-context",
  gating: "instruction",
  effectiveMode: "base",
  ruleId: null,
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

function DisabledRuleHarness({
  onMutate,
}: {
  readonly onMutate: (input: SkillVariantMutateInput) => void;
}) {
  const initialRule: SkillVariantRule = {
    ruleId: "rule-variant",
    skillName: "review-skill",
    driver: BASE_CELL.driver,
    model: BASE_CELL.model,
    mode: "variant",
    body: "Use the model-specific review workflow.",
    enabled: true,
    forkedFromRuleId: null,
    revision: 2,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
    deletedAt: null,
  };
  const [rule, setRule] = useState(initialRule);
  const [cell, setCell] = useState<SkillModelCell>({
    ...BASE_CELL,
    effectiveMode: "variant",
    ruleId: initialRule.ruleId,
    matchingRuleId: initialRule.ruleId,
  });
  const mutate = (input: SkillVariantMutateInput) => {
    onMutate(input);
    if (input.action === "disable") {
      setRule((current) => ({ ...current, enabled: false }));
      setCell((current) => ({ ...current, effectiveMode: "base", ruleId: null }));
    }
    if (input.action === "enable") {
      setRule((current) => ({ ...current, enabled: true }));
      setCell((current) => ({ ...current, effectiveMode: "variant", ruleId: initialRule.ruleId }));
    }
  };
  return (
    <SkillVariantPanel
      skillName="review-skill"
      cell={cell}
      rules={[rule]}
      revisions={[]}
      canMutate
      busy={false}
      onMutate={mutate}
    />
  );
}

function ReverseActionHarness({
  onMutate,
}: {
  readonly onMutate: (input: SkillVariantMutateInput) => void;
}) {
  const [cell, setCell] = useState(BASE_CELL);
  const [rule, setRule] = useState<SkillVariantRule | null>(null);
  const mutate = (input: SkillVariantMutateInput) => {
    onMutate(input);
    if (input.action !== "set-off") return;
    const nextRule: SkillVariantRule = {
      ruleId: "rule-off",
      skillName: "review-skill",
      driver: input.driver ?? null,
      model: input.model ?? null,
      mode: "off",
      body: null,
      enabled: true,
      forkedFromRuleId: null,
      revision: 1,
      createdAt: "2026-10-29T00:00:00.000Z",
      updatedAt: "2026-10-29T00:00:00.000Z",
      deletedAt: null,
    };
    setRule(nextRule);
    setCell({ ...cell, effectiveMode: "off", ruleId: nextRule.ruleId });
  };
  return (
    <SkillVariantActions
      skillName="review-skill"
      cell={cell}
      rule={rule}
      canMutate
      busy={false}
      onMutate={mutate}
      onFork={() => undefined}
    />
  );
}

it("forks the base skill without asking for its body", async () => {
  const onMutate = vi.fn();
  // This isolated settings panel does not navigate, so a router would add unrelated setup.
  await using screen = await render(
    <SkillVariantPanel
      skillName="review-skill"
      cell={BASE_CELL}
      rules={[]}
      revisions={[]}
      canMutate
      busy={false}
      onMutate={onMutate}
    />,
    { router: false },
  );

  await userEvent.click(screen.getByRole("button", { name: "Fork for model…" }));

  const dialog = page.getByRole("dialog");
  await expect
    .element(dialog.getByText("The server copies the current base SKILL.md into the new variant."))
    .toBeVisible();
  await expect.element(dialog.getByLabelText("Variant body")).not.toBeInTheDocument();
  (dialog.getByRole("button", { name: "Create variant" }).element() as HTMLButtonElement).click();

  expect(onMutate).toHaveBeenCalledWith({
    action: "fork",
    skillName: "review-skill",
    driver: "claude",
    model: "claude-fable-5-1",
    forkedFromRuleId: null,
  });
});

it("keeps a disabled matching rule visible so it can be re-enabled", async () => {
  const onMutate = vi.fn();
  // This isolated settings panel does not navigate, so a router would add unrelated setup.
  await using screen = await render(<DisabledRuleHarness onMutate={onMutate} />, {
    router: false,
  });

  await userEvent.click(screen.getByRole("button", { name: "Disable" }));

  await expect.element(screen.getByText("Disabled", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(/Base skill$/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Enable" })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Revert to previous revision" }))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Delete" })).toBeVisible();
  expect(onMutate).toHaveBeenLastCalledWith({ action: "disable", ruleId: "rule-variant" });

  await userEvent.click(screen.getByRole("button", { name: "Enable" }));

  await expect.element(screen.getByText("Enabled", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(/Model variant$/)).toBeVisible();
  expect(onMutate).toHaveBeenLastCalledWith({ action: "enable", ruleId: "rule-variant" });
});

it("shows the reverse action after turning a skill off for a model", async () => {
  const onMutate = vi.fn();
  // This isolated action control does not navigate, so a router would add unrelated setup.
  await using screen = await render(<ReverseActionHarness onMutate={onMutate} />, {
    router: false,
  });

  await userEvent.click(screen.getByRole("button", { name: "Turn off for this model" }));

  await expect.element(screen.getByRole("button", { name: "Turn back on" })).toBeVisible();
  expect(onMutate).toHaveBeenCalledWith({
    action: "set-off",
    skillName: "review-skill",
    driver: "claude",
    model: "claude-fable-5-1",
  });
});
