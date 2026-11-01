import {
  OrchestratorMcpFailure,
  type SkillEvalTaskMutateInput,
  type SkillVariantMutateInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as SkillReviewService from "../../../skills/SkillReviewService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  SkillEvalRunInput,
  SkillEvalTasksInput,
  SkillsReviewInput,
  SkillVariantUpdateInput,
  SkillsToolkit,
} from "./tools.ts";

const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `${name} is required for this action.`,
        }),
      )
    : Effect.succeed(value);

const decodeInput = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: String(cause),
        }),
    ),
  );

const variantMutation = Effect.fn("SkillsToolkit.variantMutation")(function* (
  input: SkillVariantUpdateInput,
) {
  switch (input.action) {
    case "create": {
      const skillName = yield* required(input.skillName, "skillName");
      const body = yield* required(input.body, "body");
      return {
        action: input.action,
        skillName,
        ...(input.driver === undefined ? {} : { driver: input.driver }),
        ...(input.model === undefined ? {} : { model: input.model }),
        body,
      } satisfies SkillVariantMutateInput;
    }
    case "fork": {
      const skillName = yield* required(input.skillName, "skillName");
      return {
        action: "fork",
        skillName,
        ...(input.driver === undefined ? {} : { driver: input.driver }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.forkedFromRuleId === undefined
          ? {}
          : { forkedFromRuleId: input.forkedFromRuleId }),
      } satisfies SkillVariantMutateInput;
    }
    case "set-off": {
      const skillName = yield* required(input.skillName, "skillName");
      return {
        action: "set-off",
        skillName,
        ...(input.driver === undefined ? {} : { driver: input.driver }),
        ...(input.model === undefined ? {} : { model: input.model }),
      } satisfies SkillVariantMutateInput;
    }
    case "edit": {
      const ruleId = yield* required(input.ruleId, "ruleId");
      const body = yield* required(input.body, "body");
      return { action: "edit", ruleId, body } satisfies SkillVariantMutateInput;
    }
    case "enable":
    case "disable":
    case "revert":
    case "delete":
    case "restore":
      return {
        action: input.action,
        ruleId: yield* required(input.ruleId, "ruleId"),
      } satisfies SkillVariantMutateInput;
  }
});

const taskMutation = Effect.fn("SkillsToolkit.taskMutation")(function* (
  input: SkillEvalTasksInput,
) {
  switch (input.action) {
    case "list":
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The list action does not mutate tasks.",
      });
    case "add":
      return {
        action: "add",
        skillName: yield* required(input.skillName, "skillName"),
        projectId: yield* required(input.projectId, "projectId"),
        promptType: yield* required(input.promptType, "promptType"),
        prompt: yield* required(input.prompt, "prompt"),
        rubric: yield* required(input.rubric, "rubric"),
        ...(input.expectation === undefined ? {} : { expectation: input.expectation }),
        ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
      } satisfies SkillEvalTaskMutateInput;
    case "update":
      return {
        action: "update",
        taskId: yield* required(input.taskId, "taskId"),
        ...(input.promptType === undefined ? {} : { promptType: input.promptType }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(input.rubric === undefined ? {} : { rubric: input.rubric }),
        ...(input.expectation === undefined ? {} : { expectation: input.expectation }),
        ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
      } satisfies SkillEvalTaskMutateInput;
    case "archive":
    case "restore":
      return {
        action: input.action,
        taskId: yield* required(input.taskId, "taskId"),
      } satisfies SkillEvalTaskMutateInput;
    case "promote-turn":
      return {
        action: "promote-turn",
        runId: yield* required(input.runId, "runId"),
        skillName: yield* required(input.skillName, "skillName"),
        projectId: yield* required(input.projectId, "projectId"),
        promptType: yield* required(input.promptType, "promptType"),
        rubric: yield* required(input.rubric, "rubric"),
        ...(input.expectation === undefined ? {} : { expectation: input.expectation }),
        ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
      } satisfies SkillEvalTaskMutateInput;
  }
});

const runControl = Effect.fn("SkillsToolkit.runControl")(function* (input: SkillEvalRunInput) {
  const reviews = yield* SkillReviewService.SkillReviewService;
  switch (input.action) {
    case "status":
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The status action does not control runs.",
      });
    case "start": {
      const { arms, ...config } = yield* required(input.config, "config");
      return yield* reviews.controlRun({
        action: "start",
        config: arms === undefined ? config : { ...config, arms },
      });
    }
    case "cancel":
    case "resume":
      return yield* reviews.controlRun({
        action: input.action,
        evalRunId: yield* required(input.evalRunId, "evalRunId"),
      });
  }
});

const make = Effect.gen(function* () {
  const reviews = yield* SkillReviewService.SkillReviewService;

  return {
    skills_review: McpToolAccess.reads((rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInput(SkillsReviewInput, rawInput);
        if (input.skillName === undefined)
          return yield* reviews.list({ refresh: input.refresh === true });
        const detail = yield* reviews.get(input.skillName);
        return input.includeBodies === true
          ? detail
          : {
              ...detail,
              rules: detail.rules.map((rule) => ({ ...rule, body: null })),
              revisions: detail.revisions.map((revision) => ({ ...revision, body: null })),
            };
      }),
    ),
    skill_variant_update: McpToolAccess.writesEnvironment((rawInput, check) =>
      decodeInput(SkillVariantUpdateInput, rawInput).pipe(
        Effect.flatMap(variantMutation),
        Effect.flatMap((input) => reviews.mutateVariantAuthorized(input, check)),
      ),
    ),
    skill_eval_tasks: McpToolAccess.either(
      (input) => input.action === "list",
      McpToolAccess.reads((rawInput) =>
        Effect.gen(function* () {
          const input = yield* decodeInput(SkillEvalTasksInput, rawInput);
          const detail = yield* required(input.skillName, "skillName").pipe(
            Effect.flatMap(reviews.get),
          );
          return input.includeArchived === true
            ? detail.tasks
            : detail.tasks.filter((task) => task.archivedAt === null);
        }),
      ),
      McpToolAccess.writesEnvironment((rawInput, check) =>
        decodeInput(SkillEvalTasksInput, rawInput).pipe(
          Effect.flatMap(taskMutation),
          Effect.flatMap((input) => reviews.mutateTaskAuthorized(input, check)),
        ),
      ),
    ),
    skill_eval_run: McpToolAccess.either(
      (input) => input.action === "status",
      McpToolAccess.reads((rawInput) =>
        Effect.gen(function* () {
          const input = yield* decodeInput(SkillEvalRunInput, rawInput);
          return yield* required(input.evalRunId, "evalRunId").pipe(Effect.flatMap(reviews.getRun));
        }),
      ),
      McpToolAccess.either(
        (input) => input.action === "start" || input.action === "resume",
        McpToolAccess.startsThreads(
          () => ({ runtimeMode: "full-access", interactionMode: "default" }),
          (rawInput, modes) =>
            Effect.gen(function* () {
              const input = yield* decodeInput(SkillEvalRunInput, rawInput);
              yield* McpInvocationContext.requireMcpCapability("orchestration");
              if (modes.linkOrigin !== undefined) {
                return yield* new OrchestratorMcpFailure({
                  code: "capability_denied",
                  message:
                    "Linked callers cannot start or resume skill evaluations because evaluation threads do not carry link fencing.",
                });
              }
              return yield* runControl(input);
            }),
          {
            refused:
              "start or resume skill evaluation threads because evaluation threads do not carry link fencing",
          },
        ),
        McpToolAccess.writesEnvironment((rawInput, check) =>
          Effect.gen(function* () {
            const input = yield* decodeInput(SkillEvalRunInput, rawInput);
            yield* McpInvocationContext.requireMcpCapability("orchestration");
            yield* check;
            return yield* runControl(input);
          }),
        ),
      ),
    ),
  } satisfies McpToolAccess.Handlers<typeof SkillsToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(SkillsToolkit, make);
