import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ProviderCapabilities,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  SkillEvalRunConfig,
  type SkillEvalRunControlInput,
  SkillEvalRunId,
  SkillEvalTaskId,
  SkillVariantRuleId,
  ThreadId,
  type ServerProvider,
  type SkillEvalRunSummary,
  type SkillEvalTask,
  type SkillVariantRevision,
  type SkillVariantRule,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SkillEval from "./SkillEvalService.ts";
import type { ObservationalGroupSummary } from "./skillEvalStats.ts";
import * as SkillReview from "./SkillReviewService.ts";
import * as SkillUsage from "./SkillUsageService.ts";
import * as SkillVariant from "./SkillVariantService.ts";

const createdAt = "2026-10-29T00:00:00.000Z";
const claude = ProviderDriverKind.make("claude");
const codex = ProviderDriverKind.make("codex");
const codexInstance = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:skills");

const provider = (skillPath: string): ServerProvider => ({
  instanceId: codexInstance,
  driver: codex,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: createdAt,
  models: [
    { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-mini", name: "GPT-5.6 Mini", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [
    {
      name: "Review",
      description: "Review code carefully.",
      path: skillPath,
      enabled: true,
    },
  ],
  workspaceSnapshots: [
    {
      cwd: "/workspace",
      checkedAt: createdAt,
      slashCommands: [],
      skills: [{ name: "review", path: "/workspace/review/SKILL.md", enabled: true }],
    },
  ],
});

const variantRule = (input: {
  readonly ruleId: string;
  readonly driver: ProviderDriverKind | null;
  readonly model: string | null;
  readonly mode: "variant" | "off";
  readonly enabled?: boolean;
  readonly body?: string | null;
}): SkillVariantRule => ({
  ruleId: SkillVariantRuleId.make(input.ruleId),
  skillName: "review",
  driver: input.driver,
  model: input.model,
  mode: input.mode,
  enabled: input.enabled ?? true,
  forkedFromRuleId: null,
  revision: 1,
  createdAt,
  updatedAt: createdAt,
  deletedAt: null,
  body: input.body ?? (input.mode === "variant" ? "Variant body" : null),
});

const globalRule = variantRule({
  ruleId: "rule:global",
  driver: null,
  model: null,
  mode: "variant",
});
const driverRule = variantRule({
  ruleId: "rule:driver",
  driver: codex,
  model: null,
  mode: "off",
  body: null,
});
const modelRule = variantRule({
  ruleId: "rule:model",
  driver: codex,
  model: "GPT-5.6-SOL",
  mode: "variant",
  body: "Model body",
});
const disabledClaudeRule = variantRule({
  ruleId: "rule:claude-disabled",
  driver: claude,
  model: "claude-opus-5-5",
  mode: "variant",
  enabled: false,
});
const rules = [globalRule, driverRule, modelRule, disabledClaudeRule];

const revision: SkillVariantRevision = {
  ruleId: modelRule.ruleId,
  revision: 1,
  action: "create",
  mode: "variant",
  body: "Model body",
  enabled: true,
  deleted: false,
  createdAt,
};

const task: SkillEvalTask = {
  taskId: SkillEvalTaskId.make("task:review"),
  skillName: "review",
  projectId,
  promptType: "implementation",
  prompt: "Review the current diff.",
  rubric: "Find the important defects.",
  expectation: "should-use",
  baseRef: null,
  sourceRunId: null,
  createdAt,
  archivedAt: null,
};

const runConfig = SkillEvalRunConfig.make({
  skillName: "review",
  projectId,
  candidate: { instanceId: codexInstance, model: "gpt-5.6-sol" },
  arms: [
    { armId: "off", label: "Off", kind: "off", role: "control" },
    {
      armId: "variant",
      label: "Current variant",
      kind: "variant",
      ruleId: modelRule.ruleId,
      role: "treatment",
    },
  ],
  repeats: 1,
  judge: null,
  judgeSamples: 1,
  concurrency: 1,
  taskIds: [task.taskId],
  variantRevisions: { [modelRule.ruleId]: 1 },
});

const verdict = {
  verdict: "helps" as const,
  reason: null,
  effect: 0.35,
  ciLow: 0.15,
  ciHigh: 0.55,
  pAdjusted: 0.02,
  nTasks: 20,
};

const run: SkillEvalRunSummary = {
  evalRunId: SkillEvalRunId.make("eval:review"),
  skillName: "review",
  config: runConfig,
  status: "completed",
  error: null,
  createdAt,
  startedAt: createdAt,
  completedAt: createdAt,
  armResults: [
    {
      armId: "variant",
      label: "Current variant",
      kind: "variant",
      role: "treatment",
      nTasks: 20,
      repeats: 1,
      effect: 0.35,
      ciLow: 0.15,
      ciHigh: 0.55,
      pAdjusted: 0.02,
      rubricDifference: 0.4,
      completion: { rate: 0.9, ciLow: 0.7, ciHigh: 0.98 },
      controlCompletion: { rate: 0.7, ciLow: 0.5, ciHigh: 0.85 },
      medianTokens: 200,
      pairedMedianTokenDifference: 20,
      medianDurationMs: 1_000,
      pairedMedianDurationMsDifference: 100,
      medianCostUsd: null,
      pairedMedianCostUsdDifference: null,
      positionConsistency: 1,
      triggerAccuracy: { matched: 18, total: 20, rate: 0.9 },
      promptTypeResults: [],
      judge: null,
      sameFamilyAsCandidate: false,
      verdict,
    },
  ],
};

const latestVerdict = (summary: SkillEvalRunSummary = run): SkillEval.LatestSkillEvalVerdict => ({
  driver: codex,
  model: "gpt-5.6-sol",
  config: summary.config,
  armVerdicts: summary.armResults.map((result) => ({
    armId: result.armId,
    verdict: result.verdict,
  })),
});

const observation = (model: string, mode: ObservationalGroupSummary["mode"]) =>
  ({
    kind: "observational",
    confounded: true,
    skillName: "review",
    driver: codex,
    model,
    mode,
    turns: 10,
    activations: 8,
    activationRate: 0.8,
    completions: 9,
    completion: { estimate: 0.9, low: 0.6, high: 0.98 },
    reverted: 1,
    revert: { estimate: 0.1, low: 0.02, high: 0.4 },
    toolCalls: 20,
    toolFailures: 2,
    toolFailureRate: 0.1,
    tokens: { median: 200, count: 10 },
    durationMs: { median: 1_000, count: 10 },
  }) satisfies ObservationalGroupSummary;

const database = NodeSqliteClient.layer({ filename: ":memory:" });

function dependencies(input: {
  readonly provider: ServerProvider;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
  readonly rules?: ReadonlyArray<SkillVariantRule>;
  readonly mutate?: SkillVariant.SkillVariantService["Service"]["mutate"];
  readonly mutateTask?: SkillEval.SkillEvalService["Service"]["mutateTask"];
  readonly listTasks?: SkillEval.SkillEvalService["Service"]["listTasks"];
  readonly listRuns?: SkillEval.SkillEvalService["Service"]["listRuns"];
  readonly latestVerdicts?: SkillEval.SkillEvalService["Service"]["latestVerdicts"];
  readonly control?: SkillEval.SkillEvalService["Service"]["control"];
  readonly refreshWorkspaceSnapshot?: ProviderRegistry.ProviderRegistry["Service"]["refreshWorkspaceSnapshot"];
}) {
  return Layer.mergeAll(
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([input.provider]),
      ...(input.refreshWorkspaceSnapshot === undefined
        ? {}
        : { refreshWorkspaceSnapshot: input.refreshWorkspaceSnapshot }),
    }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      getMetadata: () =>
        Effect.succeed({
          driver: codex,
          continuationKey: "codex",
          enabled: true,
          capabilities: input.capabilities ?? CodexProviderCapabilitiesV2,
        }),
    }),
    Layer.mock(SkillVariant.SkillVariantService)({
      list: () => Effect.succeed(input.rules ?? rules),
      listRevisions: (ruleId) => Effect.succeed(ruleId === modelRule.ruleId ? [revision] : []),
      ...(input.mutate === undefined ? {} : { mutate: input.mutate }),
    }),
    Layer.mock(SkillUsage.SkillUsageService)({
      listTurns: () =>
        Effect.succeed([
          {
            runId: RunId.make("run:review"),
            threadId: ThreadId.make("thread:review"),
            instanceId: codexInstance,
            driver: codex,
            model: "gpt-5.6-mini",
            delivery: "developer-context",
            resolution: { entries: [], hash: "empty" },
            available: [{ name: "REVIEW", path: "/skills/review/SKILL.md" }],
            evalTrialId: null,
            createdAt,
            outcome: null,
            finalizedAt: null,
            evidence: [],
          },
        ]),
      observational: () =>
        Effect.succeed([observation("gpt-5.6-sol", "variant"), observation("gpt-5.6-mini", "off")]),
    }),
    Layer.mock(SkillEval.SkillEvalService)({
      listTasks: input.listTasks ?? (() => Effect.succeed([task])),
      listRuns: input.listRuns ?? (() => Effect.succeed([run])),
      latestVerdicts: input.latestVerdicts ?? (() => Effect.succeed([latestVerdict()])),
      ...(input.mutateTask === undefined ? {} : { mutateTask: input.mutateTask }),
      ...(input.control === undefined ? {} : { control: input.control }),
    }),
  );
}

const testLayer = SkillReview.layer.pipe(
  Layer.provide(dependencies({ provider: provider("/skills/review/SKILL.md") })),
  Layer.provideMerge(database),
  Layer.provideMerge(NodeServices.layer),
);
const layer = it.layer(testLayer);

const reset = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM skill_eval_runs`;
  yield* sql`DELETE FROM skill_eval_tasks`;
  yield* sql`DELETE FROM orchestration_v2_projection_threads`;
  yield* sql`DELETE FROM projection_projects`;
});

it("uses controlled verdicts only for the exact current treatment", () => {
  assert.equal(SkillReview.verdictFor(latestVerdict(), modelRule).verdict, "helps");

  const editedRule = { ...modelRule, revision: 2 };
  assert.deepEqual(SkillReview.verdictFor(latestVerdict(), editedRule), {
    verdict: "not-enough-data",
    reason: "no-evaluations",
    effect: null,
    ciLow: null,
    ciHigh: null,
    pAdjusted: null,
    nTasks: 0,
  });
  assert.equal(
    SkillReview.verdictFor(latestVerdict(), {
      ...modelRule,
      ruleId: SkillVariantRuleId.make("rule:replacement"),
    }).reason,
    "no-evaluations",
  );
  assert.equal(
    SkillReview.verdictFor(latestVerdict(), { ...modelRule, mode: "off", body: null }).reason,
    "no-evaluations",
  );
  assert.equal(SkillReview.verdictFor(latestVerdict(), null).reason, "no-evaluations");

  const treatment = run.armResults[0]!;
  const controlFirst: SkillEvalRunSummary = {
    ...run,
    armResults: [
      {
        ...treatment,
        armId: "off",
        label: "Off",
        kind: "off",
        role: "control",
        verdict: { ...verdict, verdict: "hurts" },
      },
      treatment,
    ],
  };
  assert.equal(SkillReview.verdictFor(latestVerdict(controlFirst), modelRule).verdict, "helps");

  const unmatched: SkillEvalRunSummary = {
    ...run,
    armResults: [{ ...treatment, armId: "different-arm" }],
  };
  assert.equal(
    SkillReview.verdictFor(latestVerdict(unmatched), modelRule).reason,
    "no-evaluations",
  );

  const offRule = { ...modelRule, mode: "off" as const, body: null };
  const offRun: SkillEvalRunSummary = {
    ...run,
    config: {
      ...run.config,
      arms: [
        { armId: "base", label: "Base", kind: "base", role: "control" },
        {
          armId: "current-off",
          label: "Current off rule",
          kind: "off",
          ruleId: offRule.ruleId,
          role: "treatment",
        },
      ],
    },
    armResults: [
      {
        ...treatment,
        armId: "current-off",
        label: "Current off rule",
        kind: "off",
      },
    ],
  };
  assert.equal(SkillReview.verdictFor(latestVerdict(offRun), offRule).verdict, "helps");
  assert.equal(
    SkillReview.verdictFor(latestVerdict(offRun), { ...offRule, revision: 2 }).reason,
    "no-evaluations",
  );
});

layer("SkillReviewService", (it) => {
  it.effect("merges catalogs and evidence case-insensitively with pure rule precedence", () =>
    Effect.gen(function* () {
      yield* reset;
      const service = yield* SkillReview.SkillReviewService;
      const items = yield* service.list();

      assert.lengthOf(items, 1);
      const item = items[0]!;
      assert.equal(item.skillName, "Review");
      assert.equal(item.description, "Review code carefully.");
      assert.deepEqual(item.providers, [claude, codex]);
      assert.deepEqual(
        item.cells.map((cell) => [cell.driver, cell.model, cell.effectiveMode, cell.ruleId]),
        [
          [claude, "claude-opus-5-5", "variant", globalRule.ruleId],
          [codex, "gpt-5.6-mini", "off", driverRule.ruleId],
          [codex, "gpt-5.6-sol", "variant", modelRule.ruleId],
        ],
      );
      assert.equal(item.cells[0]?.delivery, "unsupported");
      assert.equal(item.cells[0]?.gating, "none");
      assert.equal(item.cells[1]?.delivery, "developer-context");
      assert.equal(item.cells[1]?.gating, "instruction");
      assert.equal(item.cells[1]?.observational.completionRate, 0.9);
      assert.equal(item.cells[2]?.verdict.verdict, "helps");
      assert.equal(item.cells[2]?.verdict.effect, 0.35);
    }),
  );

  it.effect("returns detail bodies, revisions, tasks, runs, and cells", () =>
    Effect.gen(function* () {
      yield* reset;
      const service = yield* SkillReview.SkillReviewService;
      const detail = yield* service.get("rEvIeW");

      assert.equal(detail.skillName, "Review");
      assert.deepEqual(detail.rules, rules);
      assert.deepEqual(detail.revisions, [revision]);
      assert.deepEqual(detail.tasks, [task]);
      assert.deepEqual(detail.runs, [run]);
      assert.lengthOf(detail.cells, 3);
    }),
  );

  it.effect("discovers skill names that only appear in evaluation tasks", () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO skill_eval_tasks (
          task_id, skill_name, project_id, prompt_type, prompt, rubric, expectation, created_at
        ) VALUES (
          'task:eval-only', 'eval-only', ${projectId}, 'implementation', 'Implement it.',
          'Complete the task.', 'either', ${createdAt}
        )
      `;
      const service = yield* SkillReview.SkillReviewService;
      const items = yield* service.list();

      assert.isTrue(items.some((item) => item.skillName === "eval-only"));

      const isRequested = (cell: { driver: string; model: string }) =>
        cell.driver === "claudeAgent" && cell.model === "gpt-5.6-luna";
      const bare = yield* service.get("eval-only");
      assert.isFalse(bare.cells.some(isRequested));
      const requested = yield* service.get("eval-only", [
        { driver: ProviderDriverKind.make("claudeAgent"), model: "gpt-5.6-luna" },
      ]);
      assert.deepEqual(
        requested.cells.filter(isRequested).map((cell) => cell.effectiveMode),
        ["base"],
      );
    }),
  );
});

it.effect("uses cached snapshots for recent project roots without probing", () =>
  Effect.gen(function* () {
    const projectProvider = {
      ...provider("/skills/review/SKILL.md"),
      skills: [],
      workspaceSnapshots: [
        {
          cwd: "/workspace",
          checkedAt: createdAt,
          slashCommands: [],
          skills: [
            {
              name: "workspace-only",
              path: "/workspace/.claude/skills/workspace-only/SKILL.md",
              enabled: true,
            },
          ],
        },
        {
          cwd: "/unrelated",
          checkedAt: createdAt,
          slashCommands: [],
          skills: [
            {
              name: "unrelated",
              path: "/unrelated/.claude/skills/unrelated/SKILL.md",
              enabled: true,
            },
          ],
        },
      ],
    } satisfies ServerProvider;
    yield* Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          ${projectId}, 'Skills project', '/workspace', '[]', ${createdAt}, ${createdAt}
        )
      `;
      const service = yield* SkillReview.SkillReviewService;
      const items = yield* service.list();

      assert.isTrue(items.some((item) => item.skillName === "workspace-only"));
      assert.isFalse(items.some((item) => item.skillName === "unrelated"));
    }).pipe(
      Effect.provide(
        SkillReview.layer.pipe(
          Layer.provide(
            dependencies({
              provider: projectProvider,
              refreshWorkspaceSnapshot: () =>
                Effect.die("Plain review lists must not probe provider catalogs."),
            }),
          ),
          Layer.provideMerge(database),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refreshes the 50 most recent project roots through the provider registry", () =>
  Effect.gen(function* () {
    const refreshes = yield* Ref.make<
      ReadonlyArray<{ readonly instanceId: ProviderInstanceId; readonly cwd: string }>
    >([]);
    const refreshWorkspaceSnapshot: ProviderRegistry.ProviderRegistry["Service"]["refreshWorkspaceSnapshot"] =
      (input) =>
        Ref.update(refreshes, (current) => [...current, input]).pipe(
          Effect.as([provider("/skills/review/SKILL.md")]),
        );
    yield* Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      for (let index = 0; index < 55; index++) {
        const suffix = String(index).padStart(2, "0");
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, created_at, updated_at
          ) VALUES (
            ${`project:refresh-${suffix}`}, ${`Project ${suffix}`}, ${`/workspace/${suffix}`},
            '[]', ${`2026-10-29T00:${suffix}:00.000Z`}, ${`2026-10-29T00:${suffix}:00.000Z`}
          )
        `;
      }
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        ) VALUES (
          'thread:recent-refresh', 'project:refresh-00', 'Recent thread', 'codex',
          'full-access', 'default', ${createdAt}, '2026-10-29T01:00:00.000Z', '{}'
        )
      `;
      const service = yield* SkillReview.SkillReviewService;
      yield* service.list({ refresh: true });

      const calls = yield* Ref.get(refreshes);
      assert.lengthOf(calls, 50);
      assert.deepEqual(
        new Set(calls.map((call) => call.cwd)),
        new Set([
          "/workspace/00",
          ...Array.from(
            { length: 49 },
            (_, index) => `/workspace/${String(index + 6).padStart(2, "0")}`,
          ),
        ]),
      );
      assert.isTrue(calls.every((call) => call.instanceId === codexInstance));
    }).pipe(
      Effect.provide(
        SkillReview.layer.pipe(
          Layer.provide(
            dependencies({
              provider: provider("/skills/review/SKILL.md"),
              refreshWorkspaceSnapshot,
            }),
          ),
          Layer.provideMerge(database),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("uses native gating from adapter capabilities", () =>
  Effect.gen(function* () {
    yield* reset;
    const service = yield* SkillReview.SkillReviewService;
    const items = yield* service.list();
    assert.equal(items[0]?.cells.find((cell) => cell.driver === codex)?.gating, "native");
  }).pipe(
    Effect.provide(
      SkillReview.layer.pipe(
        Layer.provide(
          dependencies({
            provider: provider("/skills/review/SKILL.md"),
            capabilities: { ...CodexProviderCapabilitiesV2, skillGating: "native" },
          }),
        ),
        Layer.provideMerge(database),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("caps review lists and per-skill model cells", () =>
  Effect.gen(function* () {
    const limitedProvider: ServerProvider = {
      ...provider("/skills/review/SKILL.md"),
      models: Array.from({ length: 25 }, (_, index) => ({
        slug: `model-${String(index).padStart(2, "0")}`,
        name: `Model ${index}`,
        isCustom: false,
        capabilities: null,
      })),
      skills: Array.from({ length: 501 }, (_, index) => ({
        name: `skill-${String(index).padStart(3, "0")}`,
        path: `/skills/skill-${index}/SKILL.md`,
        enabled: true,
      })),
      workspaceSnapshots: [],
    };
    yield* Effect.gen(function* () {
      yield* reset;
      const service = yield* SkillReview.SkillReviewService;
      const items = yield* service.list();

      assert.lengthOf(items, 500);
      assert.lengthOf(items.find((item) => item.skillName === "review")!.cells, 24);
    }).pipe(
      Effect.provide(
        SkillReview.layer.pipe(
          Layer.provide(dependencies({ provider: limitedProvider })),
          Layer.provideMerge(database),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps review lists independent of run history assembly", () =>
  Effect.gen(function* () {
    yield* reset;
    const service = yield* SkillReview.SkillReviewService;
    const items = yield* service.list();
    assert.lengthOf(items, 1);
  }).pipe(
    Effect.provide(
      SkillReview.layer.pipe(
        Layer.provide(
          dependencies({
            provider: provider("/skills/review/SKILL.md"),
            listRuns: () => Effect.die("Review lists must not assemble run history."),
          }),
        ),
        Layer.provideMerge(database),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("caps rules, tasks, and runs while returning total counts", () =>
  Effect.gen(function* () {
    const taskInputs = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const runLimits = yield* Ref.make<ReadonlyArray<number>>([]);
    const manyRules = Array.from({ length: 205 }, (_, index) =>
      variantRule({
        ruleId: `rule:bounded-${index}`,
        driver: codex,
        model: `bounded-model-${index}`,
        mode: "variant",
      }),
    );
    const manyTasks = Array.from({ length: 205 }, (_, index) => ({
      ...task,
      taskId: SkillEvalTaskId.make(`task:bounded-${index}`),
    }));
    const manyRuns = Array.from({ length: 25 }, (_, index) => ({
      ...run,
      evalRunId: SkillEvalRunId.make(`eval:bounded-${index}`),
    }));
    const listTasks: SkillEval.SkillEvalService["Service"]["listTasks"] = (input) =>
      Ref.update(taskInputs, (current) => [...current, input]).pipe(Effect.as(manyTasks));
    const listRuns: SkillEval.SkillEvalService["Service"]["listRuns"] = (_skillName, limit) =>
      Ref.update(runLimits, (current) => [...current, limit ?? -1]).pipe(Effect.as(manyRuns));

    yield* Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        WITH RECURSIVE numbers(value) AS (
          SELECT 0
          UNION ALL
          SELECT value + 1 FROM numbers WHERE value < 204
        )
        INSERT INTO skill_eval_tasks (
          task_id, skill_name, project_id, prompt_type, prompt, rubric, expectation, created_at
        )
        SELECT
          'task:count-' || value, 'review', ${projectId}, 'implementation', 'Prompt', 'Rubric',
          'either', ${createdAt}
        FROM numbers
      `;
      yield* sql`
        WITH RECURSIVE numbers(value) AS (
          SELECT 0
          UNION ALL
          SELECT value + 1 FROM numbers WHERE value < 24
        )
        INSERT INTO skill_eval_runs (
          eval_run_id, skill_name, config_json, status, error, created_at, started_at, completed_at
        )
        SELECT
          'eval:count-' || value, 'review', '{}', 'completed', NULL, ${createdAt}, ${createdAt},
          ${createdAt}
        FROM numbers
      `;

      const service = yield* SkillReview.SkillReviewService;
      const detail = yield* service.get("review");
      assert.lengthOf(detail.rules, 200);
      assert.lengthOf(detail.tasks, 200);
      assert.lengthOf(detail.runs, 20);
      assert.equal(detail.ruleCount, 205);
      assert.equal(detail.taskCount, 205);
      assert.equal(detail.runCount, 25);
      assert.deepEqual(yield* Ref.get(taskInputs), [
        { skillName: "Review", includeArchived: true, limit: 200 },
      ]);
      assert.deepEqual(yield* Ref.get(runLimits), [20]);
    }).pipe(
      Effect.provide(
        SkillReview.layer.pipe(
          Layer.provide(
            dependencies({
              provider: provider("/skills/review/SKILL.md"),
              rules: manyRules,
              listTasks,
              listRuns,
            }),
          ),
          Layer.provideMerge(database),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("synthesizes off versus the effective variant when run arms are omitted", () =>
  Effect.gen(function* () {
    const captured = yield* Ref.make<SkillEvalRunControlInput | undefined>(undefined);
    const control: SkillEval.SkillEvalService["Service"]["control"] = (input) =>
      Ref.set(captured, input).pipe(Effect.as(run));
    const { arms: _arms, ...config } = runConfig;
    yield* Effect.gen(function* () {
      const service = yield* SkillReview.SkillReviewService;
      yield* service.controlRun({ action: "start", config });
      assert.deepEqual(yield* Ref.get(captured), {
        action: "start",
        config: {
          ...config,
          arms: [
            { armId: "off", label: "Off", kind: "off", role: "control" },
            {
              armId: "variant",
              label: "Current variant",
              kind: "variant",
              ruleId: modelRule.ruleId,
              role: "treatment",
            },
          ],
        },
      });
    }).pipe(
      Effect.provide(
        SkillReview.layer.pipe(
          Layer.provide(dependencies({ provider: provider("/skills/review/SKILL.md"), control })),
          Layer.provideMerge(database),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("synthesizes base versus the exact off rule when off is effective", () =>
  Effect.gen(function* () {
    const captured = yield* Ref.make<SkillEvalRunControlInput | undefined>(undefined);
    const control: SkillEval.SkillEvalService["Service"]["control"] = (input) =>
      Ref.set(captured, input).pipe(Effect.as(run));
    const offRule = { ...modelRule, mode: "off" as const, body: null };
    const { arms: _arms, ...config } = runConfig;
    yield* Effect.gen(function* () {
      const service = yield* SkillReview.SkillReviewService;
      yield* service.controlRun({ action: "start", config });
      assert.deepEqual(yield* Ref.get(captured), {
        action: "start",
        config: {
          ...config,
          arms: [
            { armId: "base", label: "Base", kind: "base", role: "control" },
            {
              armId: "off",
              label: "Current off rule",
              kind: "off",
              ruleId: offRule.ruleId,
              role: "treatment",
            },
          ],
        },
      });
    }).pipe(
      Effect.provide(
        SkillReview.layer.pipe(
          Layer.provide(
            dependencies({
              provider: provider("/skills/review/SKILL.md"),
              rules: [offRule],
              control,
            }),
          ),
          Layer.provideMerge(database),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed error when a base skill is absent from the catalog", () =>
  Effect.gen(function* () {
    yield* reset;
    const service = yield* SkillReview.SkillReviewService;
    const error = yield* service
      .mutateVariant({ action: "fork", skillName: "review", driver: codex })
      .pipe(Effect.flip);
    assert.equal(error._tag, "SkillVariantValidationError");
  }).pipe(
    Effect.provide(
      SkillReview.layer.pipe(
        Layer.provide(
          dependencies({
            provider: {
              ...provider("/skills/review/SKILL.md"),
              skills: [],
              workspaceSnapshots: [],
            },
          }),
        ),
        Layer.provideMerge(database),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("returns a typed error when a catalog SKILL.md cannot be read", () =>
  Effect.gen(function* () {
    yield* reset;
    const service = yield* SkillReview.SkillReviewService;
    const error = yield* service
      .mutateVariant({ action: "fork", skillName: "review", driver: codex })
      .pipe(Effect.flip);
    assert.equal(error._tag, "SkillVariantPersistenceError");
  }).pipe(
    Effect.provide(
      SkillReview.layer.pipe(
        Layer.provide(dependencies({ provider: provider("/missing/review/SKILL.md") })),
        Layer.provideMerge(database),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("rechecks authorization after reading a base skill and before forking", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const skillPath = `${directory}/SKILL.md`;
    yield* fileSystem.writeFileString(skillPath, "# Frozen base\n");
    const captured = yield* Ref.make<string | undefined>(undefined);
    const mutate: SkillVariant.SkillVariantService["Service"]["mutate"] = (input) =>
      input.action === "fork"
        ? Ref.set(captured, input.body).pipe(Effect.as(modelRule))
        : Effect.die("Unexpected mutation");

    yield* Effect.gen(function* () {
      yield* reset;
      const service = yield* SkillReview.SkillReviewService;
      yield* service.mutateVariantAuthorized(
        { action: "fork", skillName: "review", driver: codex },
        fileSystem.writeFileString(skillPath, "# Changed after authorization\n"),
      );
      assert.equal(yield* Ref.get(captured), "# Frozen base\n");
      assert.equal(yield* fileSystem.readFileString(skillPath), "# Changed after authorization\n");
    }).pipe(
      Effect.provide(
        SkillReview.layer.pipe(
          Layer.provide(dependencies({ provider: provider(skillPath), mutate })),
          Layer.provideMerge(database),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("rechecks authorization immediately before a task mutation", () =>
  Effect.gen(function* () {
    const operations = yield* Ref.make<ReadonlyArray<string>>([]);
    const mutateTask: SkillEval.SkillEvalService["Service"]["mutateTask"] = () =>
      Ref.update(operations, (current) => [...current, "mutate"]).pipe(Effect.as(task));
    yield* Effect.gen(function* () {
      yield* reset;
      const service = yield* SkillReview.SkillReviewService;
      yield* service.mutateTaskAuthorized(
        { action: "archive", taskId: task.taskId },
        Ref.update(operations, (current) => [...current, "authorize"]),
      );
      assert.deepEqual(yield* Ref.get(operations), ["authorize", "mutate"]);
    }).pipe(
      Effect.provide(
        SkillReview.layer.pipe(
          Layer.provide(
            dependencies({
              provider: provider("/skills/review/SKILL.md"),
              mutateTask,
            }),
          ),
          Layer.provideMerge(database),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("loads a bounded catalog SKILL.md body when forking from base", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const skillPath = `${directory}/SKILL.md`;
    yield* fileSystem.writeFileString(skillPath, "# Base review\n");
    const captured = yield* Ref.make<string | undefined>(undefined);
    const mutate: SkillVariant.SkillVariantService["Service"]["mutate"] = (input) =>
      input.action === "fork"
        ? Ref.set(captured, input.body).pipe(Effect.as(modelRule))
        : Effect.die("Unexpected mutation");
    yield* Effect.gen(function* () {
      yield* reset;
      const service = yield* SkillReview.SkillReviewService;
      yield* service.mutateVariant({
        action: "fork",
        skillName: "review",
        driver: codex,
      });
      assert.equal(yield* Ref.get(captured), "# Base review\n");
    }).pipe(
      Effect.provide(
        SkillReview.layer.pipe(
          Layer.provide(dependencies({ provider: provider(skillPath), mutate })),
          Layer.provideMerge(database),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
