import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  SkillEvalRunConfig,
  SkillEvalRunId,
  SkillEvalTaskId,
  SkillEvalTrialId,
  type ServerProvider,
  type SkillEvalTaskSnapshot,
  type SkillEvalTrial,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SkillUsage from "./SkillUsageService.ts";
import {
  assembleSkillEvalArmResults,
  buildSkillEvalTrialCells,
  deterministicSkillEvalShuffle,
  interruptActiveSkillEvalRuns,
  layer as skillEvalLayer,
  SkillEvalService,
} from "./SkillEvalService.ts";

const projectId = ProjectId.make("project:eval");
const candidateInstanceId = ProviderInstanceId.make("codex");
const judgeInstanceId = ProviderInstanceId.make("claude");
const evalRunId = SkillEvalRunId.make("eval:seeded");
const createdAt = "2026-10-29T00:00:00.000Z";

const provider = (input: {
  readonly instanceId: typeof candidateInstanceId;
  readonly driver: string;
  readonly model: string;
}): ServerProvider => ({
  instanceId: input.instanceId,
  driver: ProviderDriverKind.make(input.driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: createdAt,
  models: [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

const adapterRegistryLayer = (
  driver = ProviderDriverKind.make("codex"),
  skillVariantDelivery: "developer-context" | "unsupported" = "developer-context",
) =>
  Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: () => Effect.die("metadata is available"),
      list: () => Effect.succeed([candidateInstanceId]),
      getMetadata: () =>
        Effect.succeed({
          driver,
          continuationKey: "test",
          enabled: true,
          capabilities: {
            ...CodexProviderCapabilitiesV2,
            skillVariantDelivery,
            skillGating: skillVariantDelivery === "unsupported" ? "none" : "instruction",
          },
        }),
    }),
  );

const config = SkillEvalRunConfig.make({
  skillName: "review",
  projectId,
  candidate: { instanceId: candidateInstanceId, model: "gpt-5.6-sol" },
  arms: [
    { armId: "off", label: "Off", kind: "off", role: "control" },
    { armId: "base", label: "Base", kind: "base", role: "treatment" },
  ],
  repeats: 1,
  judge: { instanceId: judgeInstanceId, model: "claude-fable-5-1" },
  judgeSamples: 1,
  concurrency: 2,
  taskIds: [],
  variantRevisions: {},
});
const StoredRunConfig = Schema.fromJsonString(SkillEvalRunConfig);
const encodeRunConfig = Schema.encodeUnknownEffect(StoredRunConfig);
const decodeRunConfig = Schema.decodeUnknownEffect(StoredRunConfig);

describe("skill evaluation trial generation", () => {
  it("creates every task by arm by repeat cell exactly once", () => {
    const taskIds = [SkillEvalTaskId.make("task:a"), SkillEvalTaskId.make("task:b")];
    const cells = buildSkillEvalTrialCells({
      evalRunId,
      taskIds,
      arms: config.arms,
      repeats: 3,
    });

    assert.lengthOf(cells, 12);
    assert.equal(
      new Set(cells.map((cell) => `${cell.taskId}:${cell.armId}:${cell.repeatIndex}`)).size,
      12,
    );
  });

  it("shuffles deterministically from the evaluation run id", () => {
    const values = Array.from({ length: 30 }, (_, index) => index);
    assert.deepEqual(
      deterministicSkillEvalShuffle(values, "eval:same"),
      deterministicSkillEvalShuffle(values, "eval:same"),
    );
    assert.notDeepEqual(
      deterministicSkillEvalShuffle(values, "eval:same"),
      deterministicSkillEvalShuffle(values, "eval:different"),
    );
    assert.deepEqual(
      deterministicSkillEvalShuffle(values, "eval:same").toSorted((left, right) => left - right),
      values,
    );
  });
});

it.effect("assembles seeded overall and per-prompt-type results", () =>
  Effect.gen(function* () {
    const tasks = new Map<SkillEvalTaskId, SkillEvalTaskSnapshot>();
    const trials: SkillEvalTrial[] = [];
    const outcomes = new Map<
      SkillEvalTrialId,
      {
        readonly eval_trial_id: string;
        readonly outcome_json: string | null;
        readonly activated: number;
      }
    >();
    const judgments = [];
    for (let index = 0; index < 100; index += 1) {
      const taskId = SkillEvalTaskId.make(`task:${index}`);
      tasks.set(taskId, {
        taskId,
        promptType: index < 50 ? "implementation" : "explanation",
        prompt: `Task ${index}`,
        rubric: "Correct and complete.",
        expectation: "should-use",
        baseCommit: "0123456789abcdef0123456789abcdef01234567",
      });
      for (const arm of config.arms) {
        const trialId = SkillEvalTrialId.make(`trial:${index}:${arm.armId}`);
        trials.push({
          trialId,
          evalRunId,
          taskId,
          armId: arm.armId,
          repeatIndex: 0,
          threadId: null,
          runId: null,
          status: "completed",
          error: null,
          createdAt,
          completedAt: createdAt,
        });
        outcomes.set(trialId, {
          eval_trial_id: trialId,
          outcome_json: null,
          activated: arm.armId === "base" ? 1 : 0,
        });
      }
      for (const order_label of ["treatment-first", "control-first"] as const) {
        judgments.push({
          judgment_id: `judgment:${index}:${order_label}`,
          eval_run_id: evalRunId,
          task_id: taskId,
          repeat_index: 0,
          treatment_arm_id: "base",
          control_arm_id: "off",
          order_label,
          sample_index: 0,
          preferred: "treatment" as const,
          treatment_score: 1,
          control_score: 0.5,
          rationale: "Treatment completed the task more fully.",
          judge_instance_id: judgeInstanceId,
          judge_model: "claude-fable-5-1",
          created_at: createdAt,
        });
      }
    }

    const results = yield* assembleSkillEvalArmResults({
      row: {
        eval_run_id: evalRunId,
        skill_name: "review",
        config_json: yield* encodeRunConfig({
          ...config,
          taskIds: [...tasks.keys()],
        }),
        status: "completed",
        error: null,
        created_at: createdAt,
        started_at: createdAt,
        completed_at: createdAt,
      },
      config: { ...config, taskIds: [...tasks.keys()] },
      trials,
      tasks,
      judgments,
      outcomes,
      providers: [
        provider({
          instanceId: candidateInstanceId,
          driver: "codex",
          model: "gpt-5.6-sol",
        }),
        provider({
          instanceId: judgeInstanceId,
          driver: "claudeAgent",
          model: "claude-fable-5-1",
        }),
      ],
    });

    const treatment = results.find((result) => result.armId === "base");
    assert.isDefined(treatment);
    assert.equal(treatment.verdict.verdict, "not-enough-data");
    assert.equal(treatment.verdict.reason, "too-few-repeats");
    assert.equal(treatment.effect, 1);
    assert.deepEqual(treatment.triggerAccuracy, { matched: 100, total: 100, rate: 1 });
    assert.lengthOf(treatment.promptTypeResults, 2);
    assert.deepEqual(
      treatment.promptTypeResults.map((result) => [result.promptType, result.nTasks]),
      [
        ["explanation", 50],
        ["implementation", 50],
      ],
    );
    assert.isFalse(treatment.sameFamilyAsCandidate);
  }),
);

it.effect("marks queued, running, and judging runs interrupted on startup", () => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const migrated = Layer.effectDiscard(runMigrations()).pipe(Layer.provideMerge(database));
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const encodedConfig = yield* encodeRunConfig(config);
    for (const [id, status] of [
      ["eval:queued", "queued"],
      ["eval:running", "running"],
      ["eval:judging", "judging"],
      ["eval:completed", "completed"],
    ] as const) {
      yield* sql`
        INSERT INTO skill_eval_runs (
          eval_run_id, skill_name, config_json, status, error, created_at, started_at, completed_at
        ) VALUES (${id}, 'review', ${encodedConfig}, ${status}, NULL, ${createdAt}, ${createdAt}, NULL)
      `;
    }

    const interrupted = yield* interruptActiveSkillEvalRuns();
    assert.deepEqual(
      new Set(interrupted),
      new Set(["eval:queued", "eval:running", "eval:judging"]),
    );
    const rows = yield* sql<{ readonly eval_run_id: string; readonly status: string }>`
      SELECT eval_run_id, status FROM skill_eval_runs ORDER BY eval_run_id
    `;
    assert.deepEqual(rows, [
      { eval_run_id: "eval:completed", status: "completed" },
      { eval_run_id: "eval:judging", status: "interrupted" },
      { eval_run_id: "eval:queued", status: "interrupted" },
      { eval_run_id: "eval:running", status: "interrupted" },
    ]);
  }).pipe(Effect.provide(migrated));
});

it.effect.each([
  {
    name: "a provider that is not ready",
    candidate: {
      ...provider({ instanceId: candidateInstanceId, driver: "codex", model: "gpt-5.6-sol" }),
      status: "warning" as const,
    },
    settings: {},
    delivery: "developer-context" as const,
  },
  {
    name: "a model the provider does not advertise",
    candidate: provider({
      instanceId: candidateInstanceId,
      driver: "codex",
      model: "gpt-5.6-mini",
    }),
    settings: {},
    delivery: "developer-context" as const,
  },
  {
    name: "a provider disabled for the project",
    candidate: provider({
      instanceId: candidateInstanceId,
      driver: "codex",
      model: "gpt-5.6-sol",
    }),
    settings: {
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [candidateInstanceId]: { enabled: false } } },
      },
    },
    delivery: "developer-context" as const,
  },
  {
    name: "a provider with unsupported skill delivery",
    candidate: provider({
      instanceId: candidateInstanceId,
      driver: "pi",
      model: "gpt-5.6-sol",
    }),
    settings: {},
    delivery: "unsupported" as const,
  },
] as const)("rejects $name before run insertion", ({ candidate, settings, delivery }) =>
  Effect.gen(function* () {
    const database = NodeSqliteClient.layer({ filename: ":memory:" });
    const migrated = Layer.effectDiscard(runMigrations()).pipe(Layer.provideMerge(database));
    const dependencies = Layer.mergeAll(
      IdAllocator.layer,
      Layer.succeed(ProjectService.ProjectService, {
        getById: () =>
          Effect.succeedSome({
            id: projectId,
            title: "Evaluation project",
            workspaceRoot: "/workspace",
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
            deletedAt: null,
          }),
      } as unknown as ProjectService.ProjectService["Service"]),
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([
          candidate,
          provider({
            instanceId: judgeInstanceId,
            driver: "claudeAgent",
            model: "claude-fable-5-1",
          }),
        ]),
      } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
      adapterRegistryLayer(candidate.driver, delivery),
      ServerSettings.ServerSettingsService.layerTest(settings),
      Layer.succeed(ThreadLaunch.ThreadLaunchService, {
        launch: () => Effect.die("Invalid candidates must not launch trials."),
      } as unknown as ThreadLaunch.ThreadLaunchService["Service"]),
      Layer.succeed(ThreadManagement.ThreadManagementService, {
        interruptThread: () => Effect.succeed({}),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Layer.succeed(GitVcsDriver.GitVcsDriver, {
        resolveCommit: () => Effect.die("Invalid candidates must fail before task freezing."),
      } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
      Layer.succeed(GitWorkflow.GitWorkflowService, {
        removeWorktree: () => Effect.void,
      } as unknown as GitWorkflow.GitWorkflowService["Service"]),
      Layer.succeed(SkillUsage.SkillUsageService, {
        finalizePending: () => Effect.succeed(0),
      } as unknown as SkillUsage.SkillUsageService["Service"]),
      Layer.succeed(
        TextGeneration.TextGeneration,
        TextGeneration.TextGeneration.of({
          generateCommitMessage: () => Effect.die("unused"),
          generatePrContent: () => Effect.die("unused"),
          generateBranchName: () => Effect.die("unused"),
          generateThreadTitle: () => Effect.die("unused"),
          generateReviewGuide: () => Effect.die("unused"),
          judgeSkillTrial: () => Effect.die("unused"),
        }),
      ),
    );
    const testLayer = skillEvalLayer.pipe(
      Layer.provideMerge(migrated),
      Layer.provide(dependencies),
    );

    yield* Effect.gen(function* () {
      const service = yield* SkillEvalService;
      const failure = yield* service.start(config).pipe(Effect.flip);
      assert.equal(failure._tag, "SkillEvalValidationError");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM skill_eval_runs
      `;
      assert.equal(rows[0]?.count, 0);
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("freezes task content and an immutable base commit before inserting a run", () =>
  Effect.gen(function* () {
    const launched = yield* Deferred.make<void>();
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
    const resolvedRefs = yield* Ref.make<ReadonlyArray<GitVcsDriver.GitResolveCommitInput>>([]);
    const taskId = SkillEvalTaskId.make("task:start-snapshot");
    const frozenCommit = "0123456789abcdef0123456789abcdef01234567";
    const snapshots = [
      provider({ instanceId: candidateInstanceId, driver: "codex", model: "gpt-5.6-sol" }),
      provider({
        instanceId: judgeInstanceId,
        driver: "claudeAgent",
        model: "claude-fable-5-1",
      }),
    ];
    const database = NodeSqliteClient.layer({ filename: ":memory:" });
    const migrated = Layer.effectDiscard(runMigrations()).pipe(Layer.provideMerge(database));
    const dependencies = Layer.mergeAll(
      IdAllocator.layer,
      Layer.succeed(ProjectService.ProjectService, {
        getById: () =>
          Effect.succeedSome({
            id: projectId,
            title: "Evaluation project",
            workspaceRoot: "/workspace",
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
            deletedAt: null,
          }),
      } as unknown as ProjectService.ProjectService["Service"]),
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed(snapshots),
      } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
      adapterRegistryLayer(),
      ServerSettings.ServerSettingsService.layerTest(),
      Layer.succeed(ThreadLaunch.ThreadLaunchService, {
        launch: (input: ThreadLaunch.ThreadLaunchInput) =>
          Ref.update(launches, (current) => [...current, input]).pipe(
            Effect.andThen(Deferred.succeed(launched, undefined)),
            Effect.andThen(Effect.never),
          ),
      } as unknown as ThreadLaunch.ThreadLaunchService["Service"]),
      Layer.succeed(ThreadManagement.ThreadManagementService, {
        interruptThread: () => Effect.succeed({}),
        getProjectThreadRecords: () => Effect.succeed({ thread: { worktreePath: null }, runs: [] }),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Layer.succeed(GitVcsDriver.GitVcsDriver, {
        resolveCommit: (input: GitVcsDriver.GitResolveCommitInput) =>
          Ref.update(resolvedRefs, (current) => [...current, input]).pipe(
            Effect.as({ commitSha: frozenCommit }),
          ),
      } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
      Layer.succeed(GitWorkflow.GitWorkflowService, {
        removeWorktree: () => Effect.void,
      } as unknown as GitWorkflow.GitWorkflowService["Service"]),
      Layer.succeed(SkillUsage.SkillUsageService, {
        finalizePending: () => Effect.succeed(0),
      } as unknown as SkillUsage.SkillUsageService["Service"]),
      Layer.succeed(
        TextGeneration.TextGeneration,
        TextGeneration.TextGeneration.of({
          generateCommitMessage: () => Effect.die("unused"),
          generatePrContent: () => Effect.die("unused"),
          generateBranchName: () => Effect.die("unused"),
          generateThreadTitle: () => Effect.die("unused"),
          generateReviewGuide: () => Effect.die("unused"),
          judgeSkillTrial: () => Effect.die("unused"),
        }),
      ),
    );
    const testLayer = skillEvalLayer.pipe(
      Layer.provideMerge(migrated),
      Layer.provide(dependencies),
    );

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO skill_eval_tasks (
          task_id, skill_name, project_id, prompt_type, prompt, rubric, expectation,
          base_ref, source_run_id, created_at, archived_at
        ) VALUES (
          ${taskId}, 'review', ${projectId}, 'implementation', 'Frozen prompt.', 'Frozen rubric.',
          'should-use', 'feature/base', NULL, ${createdAt}, NULL
        )
      `;
      yield* sql`
        INSERT INTO skill_variant_rules (
          rule_id, skill_name, driver, model, mode, body, enabled, forked_from_rule_id,
          revision, created_at, updated_at, deleted_at
        ) VALUES (
          'rule:variant', 'review', 'codex', 'gpt-5.6-sol', 'variant', '# Variant v2', 1, NULL,
          2, ${createdAt}, ${createdAt}, NULL
        )
      `;
      yield* sql`
        INSERT INTO skill_variant_revisions (
          rule_id, revision, action, mode, body, enabled, deleted, created_at
        ) VALUES
          ('rule:variant', 1, 'fork', 'variant', '# Variant v1', 1, 0, ${createdAt}),
          ('rule:variant', 2, 'edit', 'variant', '# Variant v2', 1, 0, ${createdAt})
      `;
      const service = yield* SkillEvalService;
      const summary = yield* service.start(
        SkillEvalRunConfig.make({
          ...config,
          judge: null,
          arms: [
            { armId: "off", label: "Off", kind: "off", role: "control" },
            {
              armId: "variant",
              label: "Variant",
              kind: "variant",
              ruleId: "rule:variant",
              role: "treatment",
            },
          ],
          taskIds: [taskId],
        }),
      );
      assert.deepEqual(summary.config.judge, {
        instanceId: judgeInstanceId,
        model: "claude-fable-5-1",
      });
      assert.deepEqual(summary.config.variantRevisions, { "rule:variant": 2 });
      yield* Deferred.await(launched);

      assert.deepEqual(yield* Ref.get(resolvedRefs), [
        { cwd: "/workspace", revision: "feature/base" },
      ]);
      assert.deepEqual(summary.config.taskSnapshots, [
        {
          taskId,
          promptType: "implementation",
          prompt: "Frozen prompt.",
          rubric: "Frozen rubric.",
          expectation: "should-use",
          baseCommit: frozenCommit,
        },
      ]);
      yield* sql`
        UPDATE skill_eval_tasks
        SET prompt_type = 'edited', prompt = 'Edited prompt.', rubric = 'Edited rubric.',
            expectation = 'either', base_ref = 'edited/base'
        WHERE task_id = ${taskId}
      `;
      const rows = yield* sql<{ readonly config_json: string }>`
        SELECT config_json FROM skill_eval_runs WHERE eval_run_id = ${summary.evalRunId}
      `;
      assert.deepEqual((yield* decodeRunConfig(rows[0]!.config_json)).judge, summary.config.judge);
      assert.deepEqual((yield* decodeRunConfig(rows[0]!.config_json)).taskSnapshots, [
        {
          taskId,
          promptType: "implementation",
          prompt: "Frozen prompt.",
          rubric: "Frozen rubric.",
          expectation: "should-use",
          baseCommit: frozenCommit,
        },
      ]);
      assert.deepEqual((yield* service.getRun(summary.evalRunId)).config.taskSnapshots, [
        {
          taskId,
          promptType: "implementation",
          prompt: "Frozen prompt.",
          rubric: "Frozen rubric.",
          expectation: "should-use",
          baseCommit: frozenCommit,
        },
      ]);
      assert.equal((yield* Ref.get(launches))[0]?.initialMessage?.text, "Frozen prompt.");
      assert.deepEqual((yield* Ref.get(launches))[0]?.workspaceStrategy, {
        type: "worktree",
        baseRef: frozenCommit,
      });
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("revalidates judge usage before start and resumed trials launch", () =>
  Effect.gen(function* () {
    const startRevalidated = yield* Deferred.make<void>();
    const resumeRevalidated = yield* Deferred.make<void>();
    const phase = yield* Ref.make<"start" | "resume">("start");
    const providerReads = yield* Ref.make(0);
    const launches = yield* Ref.make(0);
    const taskId = SkillEvalTaskId.make("task:judge-revalidation");
    const candidate = provider({
      instanceId: candidateInstanceId,
      driver: "codex",
      model: "gpt-5.6-sol",
    });
    const judge = provider({
      instanceId: judgeInstanceId,
      driver: "claudeAgent",
      model: "claude-fable-5-1",
    });
    const exhaustedJudge: ServerProvider = {
      ...judge,
      usageLimits: {
        checkedAt: createdAt,
        windows: [
          {
            id: "weekly",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 100,
            windowDurationMins: 10_080,
            resetsAt: "2099-01-01T00:00:00.000Z",
          },
        ],
      },
    };
    const database = NodeSqliteClient.layer({ filename: ":memory:" });
    const migrated = Layer.effectDiscard(runMigrations()).pipe(Layer.provideMerge(database));
    const dependencies = Layer.mergeAll(
      IdAllocator.layer,
      Layer.succeed(ProjectService.ProjectService, {
        getById: () =>
          Effect.succeedSome({
            id: projectId,
            title: "Evaluation project",
            workspaceRoot: "/workspace",
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
            deletedAt: null,
          }),
      } as unknown as ProjectService.ProjectService["Service"]),
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.gen(function* () {
          const read = yield* Ref.updateAndGet(providerReads, (count) => count + 1);
          if (read === 3) {
            const currentPhase = yield* Ref.get(phase);
            yield* Deferred.succeed(
              currentPhase === "start" ? startRevalidated : resumeRevalidated,
              undefined,
            );
          }
          return read === 1 ? [candidate, judge] : [candidate, exhaustedJudge];
        }),
      } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
      adapterRegistryLayer(),
      ServerSettings.ServerSettingsService.layerTest(),
      Layer.succeed(ThreadLaunch.ThreadLaunchService, {
        launch: () => Ref.update(launches, (count) => count + 1).pipe(Effect.andThen(Effect.never)),
      } as unknown as ThreadLaunch.ThreadLaunchService["Service"]),
      Layer.succeed(ThreadManagement.ThreadManagementService, {
        interruptThread: () => Effect.succeed({}),
        getProjectThreadRecords: () => Effect.succeed({ thread: { worktreePath: null }, runs: [] }),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Layer.succeed(GitVcsDriver.GitVcsDriver, {
        resolveCommit: () =>
          Effect.succeed({ commitSha: "0123456789abcdef0123456789abcdef01234567" }),
      } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
      Layer.succeed(GitWorkflow.GitWorkflowService, {
        removeWorktree: () => Effect.void,
      } as unknown as GitWorkflow.GitWorkflowService["Service"]),
      Layer.succeed(SkillUsage.SkillUsageService, {
        finalizePending: () => Effect.succeed(0),
      } as unknown as SkillUsage.SkillUsageService["Service"]),
      Layer.succeed(
        TextGeneration.TextGeneration,
        TextGeneration.TextGeneration.of({
          generateCommitMessage: () => Effect.die("unused"),
          generatePrContent: () => Effect.die("unused"),
          generateBranchName: () => Effect.die("unused"),
          generateThreadTitle: () => Effect.die("unused"),
          generateReviewGuide: () => Effect.die("unused"),
          judgeSkillTrial: () => Effect.die("usage-limited judges must not run"),
        }),
      ),
    );
    const testLayer = skillEvalLayer.pipe(
      Layer.provideMerge(migrated),
      Layer.provide(dependencies),
    );

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO skill_eval_tasks (
          task_id, skill_name, project_id, prompt_type, prompt, rubric, expectation,
          base_ref, source_run_id, created_at, archived_at
        ) VALUES (
          ${taskId}, 'review', ${projectId}, 'implementation', 'Implement the task.',
          'Complete the task correctly.', 'either', NULL, NULL, ${createdAt}, NULL
        )
      `;
      const service = yield* SkillEvalService;
      const summary = yield* service.start(
        SkillEvalRunConfig.make({ ...config, taskIds: [taskId] }),
      );
      yield* Deferred.await(startRevalidated);
      assert.equal(yield* Ref.get(launches), 0);

      assert.equal((yield* service.cancel(summary.evalRunId)).status, "cancelled");
      yield* Ref.set(phase, "resume");
      yield* Ref.set(providerReads, 0);

      yield* service.resume(summary.evalRunId);
      yield* Deferred.await(resumeRevalidated);
      assert.equal(yield* Ref.get(launches), 0);
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("resume launches only missing trials from frozen task snapshots", () =>
  Effect.gen(function* () {
    const launched = yield* Deferred.make<void>();
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
    const judgeCalls = yield* Ref.make(0);
    const archived = yield* Ref.make<ReadonlyArray<string>>([]);
    const removed = yield* Ref.make<ReadonlyArray<string>>([]);
    const snapshots = [
      provider({ instanceId: candidateInstanceId, driver: "codex", model: "gpt-5.6-sol" }),
      provider({
        instanceId: judgeInstanceId,
        driver: "claudeAgent",
        model: "claude-fable-5-1",
      }),
    ];
    const database = NodeSqliteClient.layer({ filename: ":memory:" });
    const migrated = Layer.effectDiscard(runMigrations()).pipe(Layer.provideMerge(database));
    const dependencies = Layer.mergeAll(
      IdAllocator.layer,
      Layer.succeed(ProjectService.ProjectService, {
        getById: () =>
          Effect.succeedSome({
            id: projectId,
            title: "Evaluation project",
            workspaceRoot: "/workspace",
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
            deletedAt: null,
          }),
      } as unknown as ProjectService.ProjectService["Service"]),
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed(snapshots),
      } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
      adapterRegistryLayer(),
      ServerSettings.ServerSettingsService.layerTest(),
      Layer.succeed(ThreadLaunch.ThreadLaunchService, {
        launch: (input: ThreadLaunch.ThreadLaunchInput) =>
          Ref.update(launches, (current) => [...current, input]).pipe(
            Effect.andThen(Deferred.succeed(launched, undefined)),
            Effect.andThen(Effect.never),
          ),
      } as unknown as ThreadLaunch.ThreadLaunchService["Service"]),
      Layer.succeed(ThreadManagement.ThreadManagementService, {
        interruptThread: () => Effect.succeed({}),
        dispatch: (command: { readonly type: string; readonly threadId: string }) =>
          command.type === "thread.archive"
            ? Ref.update(archived, (current) => [...current, command.threadId])
            : Effect.void,
        getProjectThreadRecords: (input: { threadId: string }) =>
          Effect.succeed({ thread: { worktreePath: `/worktrees/${input.threadId}` }, runs: [] }),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Layer.succeed(GitVcsDriver.GitVcsDriver, {
        statusDetailsRemote: () => Effect.die("base refs are frozen in this test"),
      } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
      Layer.succeed(GitWorkflow.GitWorkflowService, {
        removeWorktree: (input: { path: string }) =>
          Ref.update(removed, (paths) => [...paths, input.path]),
      } as unknown as GitWorkflow.GitWorkflowService["Service"]),
      Layer.succeed(SkillUsage.SkillUsageService, {
        finalizePending: () => Effect.succeed(0),
      } as unknown as SkillUsage.SkillUsageService["Service"]),
      Layer.succeed(
        TextGeneration.TextGeneration,
        TextGeneration.TextGeneration.of({
          generateCommitMessage: () => Effect.die("unused"),
          generatePrContent: () => Effect.die("unused"),
          generateBranchName: () => Effect.die("unused"),
          generateThreadTitle: () => Effect.die("unused"),
          generateReviewGuide: () => Effect.die("unused"),
          judgeSkillTrial: () =>
            Ref.update(judgeCalls, (count) => count + 1).pipe(
              Effect.as({
                preferred: "tie" as const,
                scoreA: 3,
                scoreB: 3,
                rationale: "Tie.",
              }),
            ),
        }),
      ),
    );
    const testLayer = skillEvalLayer.pipe(
      Layer.provideMerge(migrated),
      Layer.provide(dependencies),
    );

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* SkillEvalService;
      const taskId = SkillEvalTaskId.make("task:resume");
      const frozenConfig = SkillEvalRunConfig.make({
        ...config,
        taskIds: [taskId],
        taskSnapshots: [
          {
            taskId,
            promptType: "implementation",
            prompt: "Implement the frozen task.",
            rubric: "Frozen correctness rubric.",
            expectation: "either",
            baseCommit: "0123456789abcdef0123456789abcdef01234567",
          },
        ],
      });
      const encodedConfig = yield* encodeRunConfig(frozenConfig);
      yield* sql`
        INSERT INTO skill_eval_tasks (
          task_id, skill_name, project_id, prompt_type, prompt, rubric, expectation,
          base_ref, source_run_id, created_at, archived_at
        ) VALUES (
          ${taskId}, 'review', ${projectId}, 'edited', 'Edited after run creation.', 'Edited rubric.',
          'should-use', 'edited-branch', NULL, ${createdAt}, NULL
        )
      `;
      yield* sql`
        INSERT INTO skill_eval_runs (
          eval_run_id, skill_name, config_json, status, error, created_at, started_at, completed_at
        ) VALUES (
          ${evalRunId}, 'review', ${encodedConfig}, 'interrupted', 'Server stopped.',
          ${createdAt}, ${createdAt}, ${createdAt}
        )
      `;
      yield* sql`
        INSERT INTO skill_eval_trials (
          trial_id, eval_run_id, task_id, arm_id, repeat_index, thread_id, run_id,
          status, error, created_at, completed_at
        ) VALUES (
          'trial:control', ${evalRunId}, ${taskId}, 'off', 0, 'thread:control', NULL,
          'completed', NULL, ${createdAt}, ${createdAt}
        )
      `;
      yield* sql`
        INSERT INTO skill_eval_trials (
          trial_id, eval_run_id, task_id, arm_id, repeat_index, thread_id, run_id,
          status, error, created_at, completed_at
        ) VALUES (
          'trial:treatment', ${evalRunId}, ${taskId}, 'base', 0, 'thread:old', NULL,
          'running', NULL, ${createdAt}, NULL
        )
      `;

      yield* service.resume(evalRunId);
      yield* Deferred.await(launched);

      const recorded = yield* Ref.get(launches);
      assert.lengthOf(recorded, 1);
      assert.equal(recorded[0]?.initialMessage?.text, "Implement the frozen task.");
      assert.deepEqual(recorded[0]?.workspaceStrategy, {
        type: "worktree",
        baseRef: "0123456789abcdef0123456789abcdef01234567",
      });
      assert.equal(recorded[0]?.runtimeMode, "full-access");
      assert.equal(recorded[0]?.interactionMode, "default");
      assert.equal(recorded[0]?.createdBy, "system");
      assert.equal(recorded[0]?.creationSource, "server");
      assert.include(recorded[0]?.commandId ?? "", recorded[0]?.threadId ?? "");
      assert.notInclude(recorded[0]?.commandId ?? "", "thread:old");
      const rows = yield* sql<{
        readonly trial_id: string;
        readonly status: string;
        readonly thread_id: string | null;
      }>`
        SELECT trial_id, status, thread_id
        FROM skill_eval_trials
        WHERE eval_run_id = ${evalRunId}
        ORDER BY trial_id
      `;
      assert.deepEqual(rows[0], {
        trial_id: "trial:control",
        status: "completed",
        thread_id: "thread:control",
      });
      assert.equal(rows[1]?.trial_id, "trial:treatment");
      assert.equal(rows[1]?.status, "running");
      assert.notEqual(rows[1]?.thread_id, ThreadId.make("thread:old"));
      assert.equal(yield* Ref.get(judgeCalls), 0);
      assert.deepEqual(yield* Ref.get(archived), ["thread:old"]);
      const removedBeforeCancel = yield* Ref.get(removed);
      assert.equal((yield* service.cancel(evalRunId)).status, "cancelled");
      assert.include(
        (yield* Ref.get(removed)).slice(removedBeforeCancel.length),
        "/worktrees/thread:control",
      );
      assert.deepEqual(yield* Ref.get(archived), ["thread:old", rows[1]?.thread_id ?? ""]);
    }).pipe(Effect.provide(testLayer));
  }),
);
