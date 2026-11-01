import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SkillEvalRunConfig,
  SkillEvalRunId,
  SkillEvalTaskId,
  SkillVariantRuleId,
  ThreadId,
  type SkillEvalRunDetail,
  type SkillEvalRunSummary,
  type SkillEvalTask,
  type SkillReviewDetail,
  type SkillReviewListItem,
  type SkillVariantRevision,
  type SkillVariantRule,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as SkillReviewService from "../../../skills/SkillReviewService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as SkillsHandlers from "./handlers.ts";
import { SkillsToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:skills");
const projectId = ProjectId.make("project:skills");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const createdAt = "2026-10-29T00:00:00.000Z";
const ruleId = SkillVariantRuleId.make("rule:review");
const taskId = SkillEvalTaskId.make("task:review");
const evalRunId = SkillEvalRunId.make("eval:review");

const rule: SkillVariantRule = {
  ruleId,
  skillName: "review",
  driver,
  model: "gpt-5.6-sol",
  mode: "variant",
  enabled: true,
  forkedFromRuleId: null,
  revision: 1,
  createdAt,
  updatedAt: createdAt,
  deletedAt: null,
  body: "Variant body",
};

const revision: SkillVariantRevision = {
  ruleId,
  revision: 1,
  action: "create",
  mode: "variant",
  body: "Variant body",
  enabled: true,
  deleted: false,
  createdAt,
};

const task: SkillEvalTask = {
  taskId,
  skillName: "review",
  projectId,
  promptType: "implementation",
  prompt: "Review the diff.",
  rubric: "Find important defects.",
  expectation: "should-use",
  baseRef: null,
  sourceRunId: null,
  createdAt,
  archivedAt: null,
};

const config = SkillEvalRunConfig.make({
  skillName: "review",
  projectId,
  candidate: { instanceId, model: "gpt-5.6-sol" },
  arms: [
    { armId: "off", label: "Off", kind: "off", role: "control" },
    {
      armId: "variant",
      label: "Current variant",
      kind: "variant",
      ruleId,
      role: "treatment",
    },
  ],
  repeats: 1,
  judge: null,
  judgeSamples: 1,
  concurrency: 1,
  taskIds: [taskId],
  variantRevisions: { [ruleId]: 1 },
});

const run: SkillEvalRunSummary = {
  evalRunId,
  skillName: "review",
  config,
  status: "queued",
  error: null,
  createdAt,
  startedAt: null,
  completedAt: null,
  armResults: [],
};

const runDetail: SkillEvalRunDetail = { ...run, trials: [] };
const cell = {
  driver,
  model: "gpt-5.6-sol",
  delivery: "developer-context" as const,
  gating: "instruction" as const,
  effectiveMode: "variant" as const,
  ruleId,
  verdict: {
    verdict: "not-enough-data" as const,
    reason: "no-evaluations" as const,
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
    confounded: true as const,
  },
};

const listItem: SkillReviewListItem = {
  skillName: "review",
  description: "Review code.",
  providers: [driver],
  cells: [cell],
};
const detail: SkillReviewDetail = {
  ...listItem,
  rules: [rule],
  revisions: [revision],
  tasks: [task],
  runs: [run],
};

type RecordedCall =
  | { readonly method: "list"; readonly input: unknown }
  | { readonly method: "get"; readonly input: string }
  | { readonly method: "mutateVariant"; readonly input: unknown }
  | { readonly method: "mutateTask"; readonly input: unknown }
  | { readonly method: "controlRun"; readonly input: unknown }
  | { readonly method: "getRun"; readonly input: unknown };

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:skills"),
  requestNamespace: "provider-session:skills",
  thread: {
    threadId,
    providerSessionId: "provider-session:skills",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const clientInvocation = (
  access: McpInvocationContext.McpClientCaller["access"],
  options: {
    readonly capabilities?: McpInvocationContext.McpInvocationScope["capabilities"];
    readonly linked?: boolean;
    readonly narrowedTo?: McpInvocationContext.ClientModes;
  } = {},
): McpInvocationContext.McpInvocationScope => ({
  ...invocation,
  thread: undefined,
  client: {
    sessionId: "session:skills",
    label: "Skills test",
    access,
    ...(options.linked === undefined ? {} : { linked: options.linked }),
    ...(options.narrowedTo === undefined ? {} : { narrowedTo: options.narrowedTo }),
  },
  capabilities: options.capabilities ?? new Set(["orchestration"]),
});

const makeHarness = Effect.fn("makeSkillsToolkitHarness")(function* () {
  const calls = yield* Ref.make<ReadonlyArray<RecordedCall>>([]);
  const record = (call: RecordedCall) => Ref.update(calls, (current) => [...current, call]);
  const dependencies = Layer.mergeAll(
    Layer.mock(SkillReviewService.SkillReviewService)({
      list: (input) => record({ method: "list", input }).pipe(Effect.as([listItem])),
      get: (input) => record({ method: "get", input }).pipe(Effect.as(detail)),
      mutateVariantAuthorized: (input, check) =>
        check.pipe(Effect.andThen(record({ method: "mutateVariant", input })), Effect.as(rule)),
      mutateTaskAuthorized: (input, check) =>
        check.pipe(Effect.andThen(record({ method: "mutateTask", input })), Effect.as(task)),
      controlRun: (input) => record({ method: "controlRun", input }).pipe(Effect.as(run)),
      getRun: (input) => record({ method: "getRun", input }).pipe(Effect.as(runDetail)),
    }),
    McpToolAccessTestkit.liveThreadsLayer,
  );
  const toolkit = yield* SkillsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(SkillsHandlers.layer).pipe(Layer.provide(dependencies)),
    ),
  );
  const call = <Name extends keyof typeof SkillsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scope: McpInvocationContext.McpInvocationScope = invocation,
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof SkillsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(dependencies),
    );
  return { call, calls };
});

describe("skills toolkit handlers", () => {
  it.effect("lists reviews or returns redacted detail with one service call", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(yield* harness.call("skills_review", {})).toEqual([listItem]);
      expect(yield* Ref.get(harness.calls)).toEqual([
        { method: "list", input: { refresh: false } },
      ]);

      yield* Ref.set(harness.calls, []);
      expect(yield* harness.call("skills_review", { refresh: true })).toEqual([listItem]);
      expect(yield* Ref.get(harness.calls)).toEqual([{ method: "list", input: { refresh: true } }]);

      yield* Ref.set(harness.calls, []);
      const redacted = yield* harness.call("skills_review", { skillName: "review" });
      expect(redacted).toMatchObject({
        rules: [{ body: null }],
        revisions: [{ body: null }],
      });
      expect(yield* Ref.get(harness.calls)).toEqual([{ method: "get", input: "review" }]);

      yield* Ref.set(harness.calls, []);
      const withBodies = yield* harness.call("skills_review", {
        skillName: "review",
        includeBodies: true,
      });
      expect(withBodies).toMatchObject({
        rules: [{ body: "Variant body" }],
        revisions: [{ body: "Variant body" }],
      });
      expect(yield* Ref.get(harness.calls)).toEqual([{ method: "get", input: "review" }]);

      yield* Ref.set(harness.calls, []);
      expect(
        yield* harness.call("skills_review", { includeBodies: "yes" } as unknown as {
          includeBodies: boolean;
        }),
      ).toMatchObject({
        message: expect.stringContaining("Invalid parameters"),
      });
      expect(yield* Ref.get(harness.calls)).toEqual([]);
    }),
  );

  it.effect("maps variant and task actions to one mutation each", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("skill_variant_update", {
        action: "create",
        skillName: "review",
        driver: "codex",
        model: "gpt-5.6-sol",
        body: "New body",
      });
      expect(yield* Ref.get(harness.calls)).toEqual([
        {
          method: "mutateVariant",
          input: {
            action: "create",
            skillName: "review",
            driver: "codex",
            model: "gpt-5.6-sol",
            body: "New body",
          },
        },
      ]);

      yield* Ref.set(harness.calls, []);
      yield* harness.call("skill_variant_update", {
        action: "fork",
        skillName: "review",
        driver: "codex",
        model: "gpt-5.6-sol",
      });
      expect(yield* Ref.get(harness.calls)).toEqual([
        {
          method: "mutateVariant",
          input: {
            action: "fork",
            skillName: "review",
            driver: "codex",
            model: "gpt-5.6-sol",
          },
        },
      ]);

      yield* Ref.set(harness.calls, []);
      yield* harness.call("skill_eval_tasks", {
        action: "update",
        taskId,
        prompt: "Updated prompt",
        expectation: "should-use",
        baseRef: null,
      });
      expect(yield* Ref.get(harness.calls)).toEqual([
        {
          method: "mutateTask",
          input: {
            action: "update",
            taskId,
            prompt: "Updated prompt",
            expectation: "should-use",
            baseRef: null,
          },
        },
      ]);

      yield* Ref.set(harness.calls, []);
      yield* harness.call("skill_eval_tasks", {
        action: "archive",
        taskId,
      });
      expect(yield* Ref.get(harness.calls)).toEqual([
        { method: "mutateTask", input: { action: "archive", taskId } },
      ]);

      yield* Ref.set(harness.calls, []);
      expect(
        yield* harness.call("skill_eval_tasks", { action: "list", skillName: "review" }),
      ).toEqual([task]);
      expect(yield* Ref.get(harness.calls)).toEqual([{ method: "get", input: "review" }]);

      yield* Ref.set(harness.calls, []);
      expect(yield* harness.call("skill_eval_tasks", { action: "list" })).toMatchObject({
        code: "invalid_request",
      });
      expect(yield* Ref.get(harness.calls)).toEqual([]);
    }),
  );

  it.effect("uses getRun for status and controlRun for starts with default arms", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(yield* harness.call("skill_eval_run", { action: "status", evalRunId })).toEqual(
        runDetail,
      );
      expect(yield* Ref.get(harness.calls)).toEqual([{ method: "getRun", input: evalRunId }]);

      yield* Ref.set(harness.calls, []);
      const { arms: _arms, ...defaultConfig } = config;
      expect(
        yield* harness.call("skill_eval_run", { action: "start", config: defaultConfig }),
      ).toEqual(run);
      expect(yield* Ref.get(harness.calls)).toEqual([
        { method: "controlRun", input: { action: "start", config: defaultConfig } },
      ]);
    }),
  );

  it.effect("requires full-access/default orchestration authority to start or resume", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { arms: _arms, ...defaultConfig } = config;
      const start = { action: "start" as const, config: defaultConfig };

      expect(
        yield* harness.call(
          "skill_eval_run",
          start,
          clientInvocation("full-access", { capabilities: new Set(["preview"]) }),
        ),
      ).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "orchestration" });
      expect(
        yield* harness.call("skill_eval_run", start, clientInvocation("read-only")),
      ).toMatchObject({ code: "capability_denied" });
      expect(
        yield* harness.call("skill_eval_run", start, clientInvocation("approval-required")),
      ).toMatchObject({ code: "runtime_mode_escalation_denied" });
      expect(
        yield* harness.call(
          "skill_eval_run",
          start,
          clientInvocation("full-access", {
            narrowedTo: { runtimeMode: "full-access", interactionMode: "plan" },
          }),
        ),
      ).toMatchObject({ code: "interaction_mode_escalation_denied" });
      expect(
        yield* harness.call(
          "skill_eval_run",
          start,
          clientInvocation("full-access", { linked: true }),
        ),
      ).toMatchObject({ code: "capability_denied" });
      expect(yield* Ref.get(harness.calls)).toEqual([]);

      expect(yield* harness.call("skill_eval_run", start, clientInvocation("full-access"))).toEqual(
        run,
      );
      expect(
        yield* harness.call(
          "skill_eval_run",
          { action: "resume", evalRunId },
          clientInvocation("full-access"),
        ),
      ).toEqual(run);
      expect(yield* Ref.get(harness.calls)).toEqual([
        { method: "controlRun", input: { action: "start", config: defaultConfig } },
        { method: "controlRun", input: { action: "resume", evalRunId } },
      ]);
    }),
  );

  it.effect("uses full-access operator authorization for shared mutations and cancellation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const restricted = clientInvocation("approval-required");

      expect(
        yield* harness.call("skill_variant_update", { action: "disable", ruleId }, restricted),
      ).toMatchObject({ code: "capability_denied" });
      expect(
        yield* harness.call("skill_eval_tasks", { action: "archive", taskId }, restricted),
      ).toMatchObject({ code: "capability_denied" });
      expect(
        yield* harness.call("skill_eval_run", { action: "cancel", evalRunId }, restricted),
      ).toMatchObject({ code: "capability_denied" });
      expect(yield* Ref.get(harness.calls)).toEqual([]);

      expect(
        yield* harness.call(
          "skill_eval_run",
          { action: "cancel", evalRunId },
          clientInvocation("full-access"),
        ),
      ).toEqual(run);
      expect(yield* Ref.get(harness.calls)).toEqual([
        { method: "controlRun", input: { action: "cancel", evalRunId } },
      ]);
    }),
  );
});
