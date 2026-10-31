import { WS_METHODS, type SkillModelCell, type SkillVariantRule } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const ruleSpecificity = (rule: SkillVariantRule, cell: SkillModelCell): number => {
  if (rule.driver === null) return 0;
  if (rule.driver !== cell.driver) return -1;
  if (rule.model === null) return 1;
  return rule.model.toLowerCase() === cell.model.toLowerCase() ? 2 : -1;
};

export function matchingSkillRuleForCell(
  cell: SkillModelCell,
  rules: ReadonlyArray<SkillVariantRule>,
): SkillVariantRule | null {
  if (cell.matchingRuleId !== undefined) {
    return rules.find((rule) => rule.ruleId === cell.matchingRuleId) ?? null;
  }
  return (
    rules
      .filter((rule) => rule.deletedAt === null && ruleSpecificity(rule, cell) >= 0)
      .sort((left, right) => ruleSpecificity(right, cell) - ruleSpecificity(left, cell))[0] ?? null
  );
}

export function createSkillEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const reviewList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:skills:review-list",
    tag: WS_METHODS.skillsReviewList,
  });
  const reviewDetail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:skills:review-detail",
    tag: WS_METHODS.skillsReviewGet,
  });
  const runDetail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:skills:eval-run-detail",
    tag: WS_METHODS.skillsEvalRunGet,
  });

  return {
    reviewList,
    reviewDetail,
    runDetail,
    refreshReviewList: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skills:refresh-review-list",
      tag: WS_METHODS.skillsReviewList,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          registry.refresh(reviewList({ environmentId, input: {} }));
        }),
    }),
    mutateVariant: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:skills:variant-mutate",
      tag: WS_METHODS.skillsVariantMutate,
      onSuccess: ({ environmentId }, registry, result) =>
        Effect.sync(() => {
          registry.refresh(reviewList({ environmentId, input: {} }));
          registry.refresh(reviewDetail({ environmentId, input: { skillName: result.skillName } }));
        }),
    }),
    mutateEvalTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:skills:eval-task-mutate",
      tag: WS_METHODS.skillsEvalTaskMutate,
      onSuccess: ({ environmentId }, registry, result) =>
        Effect.sync(() => {
          registry.refresh(reviewList({ environmentId, input: {} }));
          registry.refresh(reviewDetail({ environmentId, input: { skillName: result.skillName } }));
        }),
    }),
    controlEvalRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:skills:eval-run-control",
      tag: WS_METHODS.skillsEvalRunControl,
      onSuccess: ({ environmentId }, registry, result) =>
        Effect.sync(() => {
          registry.refresh(reviewList({ environmentId, input: {} }));
          registry.refresh(reviewDetail({ environmentId, input: { skillName: result.skillName } }));
          registry.refresh(runDetail({ environmentId, input: { evalRunId: result.evalRunId } }));
        }),
    }),
  };
}
