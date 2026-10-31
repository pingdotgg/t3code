import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  SkillTurnResolution,
  SkillVariantValidationError,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as SkillTurnPreparation from "./SkillTurnPreparation.ts";
import * as SkillUsageService from "./SkillUsageService.ts";
import * as SkillVariantService from "./SkillVariantService.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const driver = ProviderDriverKind.make("claudeAgent");
const run = {
  id: RunId.make("run:skill-preparation"),
  threadId: ThreadId.make("thread:skill-preparation"),
};
const session = {
  driver,
  providerSession: { capabilities: { skillVariantDelivery: "turn-prompt" as const } },
};
const modelSelection = { instanceId, model: "claude-opus-5-5" };
const provider = {
  instanceId,
  driver,
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  checkedAt: "2026-10-29T00:00:00.000Z",
  version: "1.0.0",
  models: [],
  slashCommands: [],
  skills: [{ name: "global", path: "/global/SKILL.md", enabled: true }],
  workspaceSnapshots: [
    {
      cwd: "/workspace",
      checkedAt: "2026-10-29T00:00:00.000Z",
      slashCommands: [],
      skills: [{ name: "review", path: "/workspace/review/SKILL.md", enabled: true }],
    },
  ],
} satisfies ServerProvider;

const database = NodeSqliteClient.layer({ filename: ":memory:" });

const markEvaluationTrial = Effect.fn("markEvaluationTrial")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO skill_eval_runs (
      eval_run_id, skill_name, config_json, status, error, created_at, started_at, completed_at
    ) VALUES (
      'eval:skill-preparation', 'review', '{}', 'running', NULL,
      '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z', NULL
    )
  `;
  yield* sql`
    INSERT INTO skill_eval_trials (
      trial_id, eval_run_id, task_id, arm_id, repeat_index, thread_id, run_id,
      status, error, created_at, completed_at
    ) VALUES (
      'trial:skill-preparation', 'eval:skill-preparation', 'task:skill-preparation',
      'variant', 0, ${run.threadId}, ${run.id}, 'running', NULL,
      '2026-10-29T00:00:00.000Z', NULL
    )
  `;
});

it.effect("materializes one native policy before recording exact catalog paths", () => {
  let recordedAvailable:
    | ReadonlyArray<{ readonly name: string; readonly path: string }>
    | undefined;
  const operations: string[] = [];
  const resolution = SkillTurnResolution.make({
    hash: "policy-hash",
    entries: [
      {
        skillName: "review",
        ruleId: "rule:review",
        revision: 1,
        mode: "variant",
        contentHash: "content-hash",
        variantPath: "/state/skill-variants/content-hash/SKILL.md",
        origin: "rule",
      },
      {
        skillName: "disabled",
        ruleId: "rule:disabled",
        revision: 1,
        mode: "off",
        contentHash: null,
        variantPath: null,
        origin: "rule",
      },
    ],
  });
  const testLayer = SkillTurnPreparation.layerOptionalProviderRegistry.pipe(
    Layer.provide(
      Layer.mergeAll(
        ProviderRegistryMock.layer([provider]),
        Layer.mock(SkillVariantService.SkillVariantService)({
          resolvePolicy: () =>
            Effect.sync(() => {
              operations.push("resolve");
              return resolution;
            }),
          materialize: () =>
            Effect.sync(() => {
              operations.push("materialize");
            }),
        }),
        Layer.mock(SkillUsageService.SkillUsageService)({
          recordTurnStart: (input) =>
            Effect.sync(() => {
              operations.push("record");
              recordedAvailable = input.available;
            }),
        }),
      ),
    ),
    Layer.provideMerge(database),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    yield* runMigrations();
    const service = yield* SkillTurnPreparation.SkillTurnPreparation;
    const prepared = yield* service.prepare({
      run,
      session,
      modelSelection,
      cwd: "/workspace",
    });

    assert.deepEqual(prepared?.skillPolicy, {
      hash: "policy-hash",
      entries: [
        {
          skillName: "review",
          mode: "variant",
          variantPath: "/state/skill-variants/content-hash/SKILL.md",
        },
        { skillName: "disabled", mode: "off", variantPath: null },
      ],
    });
    assert.include(prepared?.skillDirectives.text ?? "", "for this model");
    assert.deepEqual(operations, ["resolve", "materialize", "record"]);
    assert.deepEqual(recordedAvailable, [{ name: "review", path: "/workspace/review/SKILL.md" }]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("records unsupported sessions without returning policy or directives", () => {
  let recordedDelivery: string | undefined;
  const resolution = SkillTurnResolution.make({
    hash: "unsupported-policy",
    entries: [
      {
        skillName: "review",
        ruleId: "rule:review",
        revision: 1,
        mode: "variant",
        contentHash: "content-hash",
        variantPath: "/state/skill-variants/content-hash/SKILL.md",
        origin: "rule",
      },
    ],
  });
  const testLayer = SkillTurnPreparation.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ProviderRegistryMock.layer([provider]),
        Layer.mock(SkillVariantService.SkillVariantService)({
          resolvePolicy: () => Effect.succeed(resolution),
          materialize: () => Effect.void,
        }),
        Layer.mock(SkillUsageService.SkillUsageService)({
          recordTurnStart: (input) =>
            Effect.sync(() => {
              recordedDelivery = input.delivery;
            }),
        }),
      ),
    ),
    Layer.provideMerge(database),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    yield* runMigrations();
    const service = yield* SkillTurnPreparation.SkillTurnPreparation;
    const prepared = yield* service.prepare({
      run,
      session: {
        driver: ProviderDriverKind.make("fx"),
        providerSession: { capabilities: { skillVariantDelivery: "unsupported" } },
      },
      modelSelection: { instanceId, model: "fx-model" },
      cwd: "/workspace",
    });

    assert.isUndefined(prepared);
    assert.equal(recordedDelivery, "unsupported");
  }).pipe(Effect.provide(testLayer));
});

it.effect("rebases a project-root snapshot onto a worktree cwd without probing", () => {
  let recordedAvailable:
    | ReadonlyArray<{ readonly name: string; readonly path: string }>
    | undefined;
  const projectId = ProjectId.make("project:skill-preparation");
  const projectRoot = "/projects/t3code";
  const worktreeCwd = "/projects/t3code/.t3/worktrees/feature";
  const rootProvider = {
    ...provider,
    workspaceSnapshots: [
      {
        cwd: projectRoot,
        checkedAt: "2026-10-29T00:00:00.000Z",
        slashCommands: [],
        skills: [
          {
            name: "review",
            path: `${projectRoot}/.claude/skills/review/SKILL.md`,
            enabled: true,
          },
          { name: "shared", path: "/global/shared/SKILL.md", enabled: true },
          { name: "disabled", path: `${projectRoot}/disabled/SKILL.md`, enabled: false },
        ],
      },
    ],
  } satisfies ServerProvider;
  const resolution = SkillTurnResolution.make({ hash: "empty", entries: [] });
  const testLayer = SkillTurnPreparation.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([rootProvider]),
          refreshWorkspaceSnapshot: () => Effect.die("Turn preparation must not probe providers."),
        }),
        Layer.mock(SkillVariantService.SkillVariantService)({
          resolvePolicy: () => Effect.succeed(resolution),
          materialize: () => Effect.void,
        }),
        Layer.mock(SkillUsageService.SkillUsageService)({
          recordTurnStart: (input) =>
            Effect.sync(() => {
              recordedAvailable = input.available;
            }),
        }),
      ),
    ),
    Layer.provideMerge(database),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES (
        ${projectId}, 'Skills project', ${projectRoot}, '[]',
        '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES (
        ${run.threadId}, ${projectId}, 'Skills thread', 'claudeAgent', 'full-access', 'default',
        '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z', '{}'
      )
    `;

    const service = yield* SkillTurnPreparation.SkillTurnPreparation;
    yield* service.prepare({ run, session, modelSelection, cwd: worktreeCwd });

    assert.deepEqual(recordedAvailable, [
      {
        name: "review",
        path: `${worktreeCwd}/.claude/skills/review/SKILL.md`,
      },
      { name: "shared", path: "/global/shared/SKILL.md" },
    ]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("falls back to global provider skills without probing", () => {
  let recordedAvailable:
    | ReadonlyArray<{ readonly name: string; readonly path: string }>
    | undefined;
  const resolution = SkillTurnResolution.make({ hash: "empty", entries: [] });
  const testLayer = SkillTurnPreparation.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([{ ...provider, workspaceSnapshots: [] }]),
          refreshWorkspaceSnapshot: () => Effect.die("Turn preparation must not probe providers."),
        }),
        Layer.mock(SkillVariantService.SkillVariantService)({
          resolvePolicy: () => Effect.succeed(resolution),
          materialize: () => Effect.void,
        }),
        Layer.mock(SkillUsageService.SkillUsageService)({
          recordTurnStart: (input) =>
            Effect.sync(() => {
              recordedAvailable = input.available;
            }),
        }),
      ),
    ),
    Layer.provideMerge(database),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    yield* runMigrations();
    const service = yield* SkillTurnPreparation.SkillTurnPreparation;
    yield* service.prepare({
      run,
      session,
      modelSelection,
      cwd: "/projects/t3code/.t3/worktrees/feature",
    });
    assert.deepEqual(recordedAvailable, [{ name: "global", path: "/global/SKILL.md" }]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("fails closed when evaluation-trial identification fails", () => {
  const testLayer = SkillTurnPreparation.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ProviderRegistryMock.layer([provider]),
        Layer.mock(SkillVariantService.SkillVariantService)({
          resolvePolicy: () => Effect.die("Resolution must not run."),
          materialize: () => Effect.die("Materialization must not run."),
        }),
        Layer.mock(SkillUsageService.SkillUsageService)({
          recordTurnStart: () => Effect.die("Recording must not run."),
        }),
      ),
    ),
    Layer.provideMerge(database),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE skill_eval_trials`;
    const service = yield* SkillTurnPreparation.SkillTurnPreparation;
    const failure = yield* service
      .prepare({ run, session, modelSelection, cwd: "/workspace" })
      .pipe(Effect.flip);

    assert.equal(failure.stage, "trial-identification");
    assert.equal(failure.runId, run.id);
  }).pipe(Effect.provide(testLayer));
});

it.effect("fails closed without a provider catalog when trial identification fails", () => {
  const testLayer = SkillTurnPreparation.layerOptionalProviderRegistry.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(SkillVariantService.SkillVariantService)({
          resolvePolicy: () => Effect.die("Resolution must not run."),
          materialize: () => Effect.die("Materialization must not run."),
        }),
        Layer.mock(SkillUsageService.SkillUsageService)({
          recordTurnStart: () => Effect.die("Recording must not run."),
        }),
      ),
    ),
    Layer.provideMerge(database),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE skill_eval_trials`;
    const service = yield* SkillTurnPreparation.SkillTurnPreparation;
    const failure = yield* service
      .prepare({ run, session, modelSelection, cwd: "/workspace" })
      .pipe(Effect.flip);

    assert.equal(failure.stage, "trial-identification");
    assert.equal(failure.runId, run.id);
  }).pipe(Effect.provide(testLayer));
});

it.effect.each([
  "variant-resolution",
  "materialization",
  "provider-catalog",
  "turn-start-recording",
] as const)("fails evaluation trials during %s", (stage) => {
  const resolution = SkillTurnResolution.make({ hash: "empty", entries: [] });
  const testLayer = SkillTurnPreparation.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders:
            stage === "provider-catalog"
              ? Effect.die("provider catalog failed")
              : Effect.succeed([provider]),
        }),
        Layer.mock(SkillVariantService.SkillVariantService)({
          resolvePolicy: () =>
            stage === "variant-resolution"
              ? Effect.fail(new SkillVariantValidationError({ message: "resolution failed" }))
              : Effect.succeed(resolution),
          materialize: () =>
            stage === "materialization" ? Effect.die("materialization failed") : Effect.void,
        }),
        Layer.mock(SkillUsageService.SkillUsageService)({
          recordTurnStart: () =>
            stage === "turn-start-recording" ? Effect.die("recording failed") : Effect.void,
        }),
      ),
    ),
    Layer.provideMerge(database),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    yield* runMigrations();
    yield* markEvaluationTrial();
    const sql = yield* SqlClient.SqlClient;
    const trialRows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM skill_eval_trials WHERE thread_id = ${run.threadId}
    `;
    assert.deepEqual(trialRows, [{ thread_id: run.threadId }]);
    const service = yield* SkillTurnPreparation.SkillTurnPreparation;
    const failure = yield* service
      .prepare({ run, session, modelSelection, cwd: "/workspace" })
      .pipe(Effect.flip);

    assert.equal(failure.stage, stage);
    assert.equal(failure.runId, run.id);
    assert.include(failure.message, `failed during ${stage}`);
  }).pipe(Effect.provide(testLayer));
});

it.effect("logs preparation failures and does not fail an ordinary provider turn", () => {
  const testLayer = SkillTurnPreparation.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ProviderRegistryMock.layer([provider]),
        Layer.mock(SkillVariantService.SkillVariantService)({
          resolvePolicy: () =>
            Effect.fail(new SkillVariantValidationError({ message: "resolution failed" })),
          materialize: () => Effect.die("Materialization must not run after resolution fails."),
        }),
        Layer.mock(SkillUsageService.SkillUsageService)({
          recordTurnStart: () => Effect.void,
        }),
      ),
    ),
    Layer.provideMerge(database),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    yield* runMigrations();
    const service = yield* SkillTurnPreparation.SkillTurnPreparation;
    assert.isUndefined(yield* service.prepare({ run, session, modelSelection, cwd: "/workspace" }));
  }).pipe(Effect.provide(testLayer));
});
