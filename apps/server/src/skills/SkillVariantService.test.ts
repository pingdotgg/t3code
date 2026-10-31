import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SkillEvalRunConfig,
  SkillVariantConflictError,
  ThreadId,
  type SkillVariantRule,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as SkillVariants from "./SkillVariantService.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-skill-variants-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const testLayer = SkillVariants.layer.pipe(
  Layer.provideMerge(database),
  Layer.provideMerge(config),
  Layer.provideMerge(NodeServices.layer),
);
const layer = it.layer(testLayer);

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const encodeEvalConfig = Schema.encodeUnknownSync(Schema.fromJsonString(SkillEvalRunConfig));
const isSkillVariantConflictError = Schema.is(SkillVariantConflictError);

const reset = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM skill_eval_judgments`;
  yield* sql`DELETE FROM skill_eval_trials`;
  yield* sql`DELETE FROM skill_eval_runs`;
  yield* sql`DELETE FROM skill_eval_tasks`;
  yield* sql`DELETE FROM skill_turn_evidence`;
  yield* sql`DELETE FROM skill_turns`;
  yield* sql`DELETE FROM skill_variant_revisions`;
  yield* sql`DELETE FROM skill_variant_rules`;
});

function createVariant(input: {
  readonly skillName: string;
  readonly body: string;
  readonly driver?: ProviderDriverKind;
  readonly model?: string;
}) {
  return Effect.gen(function* () {
    const service = yield* SkillVariants.SkillVariantService;
    return yield* service.mutate({ action: "create", ...input });
  });
}

function entryBody(rule: SkillVariantRule) {
  assert.equal(rule.mode, "variant");
  assert.isNotNull(rule.body);
  return rule.body;
}

layer("SkillVariantService", (it) => {
  it.effect(
    "resolves model, driver and global precedence with terminal off and disabled fallthrough",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const service = yield* SkillVariants.SkillVariantService;
        const global = yield* createVariant({ skillName: "Review", body: "global" });
        const driver = yield* createVariant({
          skillName: "review",
          driver: codex,
          body: "driver",
        });
        const model = yield* createVariant({
          skillName: "REVIEW",
          driver: codex,
          model: "GPT-5.6-SOL",
          body: "model",
        });

        const resolve = (driverKind: ProviderDriverKind, modelSlug: string, thread: string) =>
          service.resolvePolicy({
            driver: driverKind,
            model: modelSlug,
            threadId: ThreadId.make(thread),
          });

        assert.equal(
          (yield* resolve(codex, "gpt-5.6-sol", "model-thread")).entries[0]?.ruleId,
          model.ruleId,
        );
        assert.equal(
          (yield* resolve(codex, "gpt-5.6-mini", "driver-thread")).entries[0]?.ruleId,
          driver.ruleId,
        );
        assert.equal(
          (yield* resolve(claude, "claude-fable-5-1", "global-thread")).entries[0]?.ruleId,
          global.ruleId,
        );

        yield* service.mutate({
          action: "set-off",
          skillName: "review",
          driver: codex,
          model: "gpt-5.6-sol",
        });
        const off = (yield* resolve(codex, "GPT-5.6-SOL", "off-thread")).entries[0];
        assert.equal(off?.mode, "off");
        assert.equal(off?.ruleId, model.ruleId);

        yield* service.mutate({ action: "disable", ruleId: model.ruleId });
        assert.equal(
          (yield* resolve(codex, "gpt-5.6-sol", "fallback-thread")).entries[0]?.ruleId,
          driver.ruleId,
        );
      }),
  );

  it.effect("appends reversible revisions for every variant mutation", () =>
    Effect.gen(function* () {
      yield* reset;
      const service = yield* SkillVariants.SkillVariantService;
      const created = yield* createVariant({ skillName: "review", body: "first" });

      const edited = yield* service.mutate({
        action: "edit",
        ruleId: created.ruleId,
        body: "second",
      });
      assert.equal(entryBody(edited), "second");
      yield* service.mutate({ action: "disable", ruleId: created.ruleId });
      yield* service.mutate({ action: "enable", ruleId: created.ruleId });
      const reverted = yield* service.mutate({ action: "revert", ruleId: created.ruleId });
      assert.equal(entryBody(reverted), "first");

      const disabled = yield* service.mutate({ action: "disable", ruleId: created.ruleId });
      assert.isFalse(disabled.enabled);
      const enabled = yield* service.mutate({ action: "enable", ruleId: created.ruleId });
      assert.isTrue(enabled.enabled);

      const off = yield* service.mutate({ action: "set-off", skillName: "review" });
      assert.equal(off.mode, "off");
      assert.isNull(off.body);
      const variant = yield* service.mutate({
        action: "set-variant",
        skillName: "review",
        body: "third",
      });
      assert.equal(entryBody(variant), "third");

      const deleted = yield* service.mutate({ action: "delete", ruleId: created.ruleId });
      assert.isNotNull(deleted.deletedAt);
      const restored = yield* service.mutate({ action: "restore", ruleId: created.ruleId });
      assert.isNull(restored.deletedAt);

      const fork = yield* service.mutate({
        action: "fork",
        skillName: "review",
        driver: claude,
        forkedFromRuleId: created.ruleId,
      });
      assert.equal(entryBody(fork), "third");
      assert.equal(fork.driver, claude);
      assert.equal(fork.forkedFromRuleId, created.ruleId);
      const deletedFork = yield* service.mutate({ action: "delete", ruleId: fork.ruleId });
      assert.isNotNull(deletedFork.deletedAt);

      const baseFork = yield* service.mutate({
        action: "fork",
        skillName: "docs",
        driver: codex,
        body: "base body",
      });
      assert.equal(entryBody(baseFork), "base body");
      assert.isNull(baseFork.forkedFromRuleId);
      assert.isNotNull(
        (yield* service.mutate({ action: "delete", ruleId: baseFork.ruleId })).deletedAt,
      );

      const revisions = yield* service.listRevisions(created.ruleId, 20);
      assert.deepEqual(
        revisions.map((revision) => revision.action),
        [
          "restore",
          "delete",
          "set-variant",
          "set-off",
          "enable",
          "disable",
          "revert",
          "enable",
          "disable",
          "edit",
          "create",
        ],
      );
      assert.equal(reverted.revision, edited.revision + 3);
    }),
  );

  it.effect("rejects restore when another live rule owns the target", () =>
    Effect.gen(function* () {
      yield* reset;
      const service = yield* SkillVariants.SkillVariantService;
      const original = yield* createVariant({
        skillName: "review",
        driver: codex,
        model: "gpt-5.6-sol",
        body: "old",
      });
      yield* service.mutate({ action: "delete", ruleId: original.ruleId });
      const replacement = yield* createVariant({
        skillName: "review",
        driver: codex,
        model: "GPT-5.6-SOL",
        body: "new",
      });

      const failure = yield* service
        .mutate({ action: "restore", ruleId: original.ruleId })
        .pipe(Effect.flip);
      assert.isTrue(isSkillVariantConflictError(failure));
      if (isSkillVariantConflictError(failure)) {
        assert.equal(failure.conflictingRuleId, replacement.ruleId);
      }
    }),
  );

  it.effect("keeps policy resolution read-only and materializes exact revisions idempotently", () =>
    Effect.gen(function* () {
      yield* reset;
      const service = yield* SkillVariants.SkillVariantService;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* createVariant({
        skillName: "review",
        driver: codex,
        model: "gpt-5.6-sol",
        body: "variant body",
      });
      const resolution = yield* service.resolvePolicy({
        driver: codex,
        model: "gpt-5.6-sol",
        threadId: ThreadId.make("materialize-thread"),
      });
      const entry = resolution.entries[0];
      assert.isDefined(entry);
      assert.match(entry?.variantPath ?? "", /skill-variants\/[a-f0-9]{64}\/SKILL\.md$/);
      assert.isFalse(yield* fileSystem.exists(entry?.variantPath ?? ""));

      yield* service.materialize(resolution);
      yield* service.materialize(resolution);

      assert.equal(yield* fileSystem.readFileString(entry?.variantPath ?? ""), "variant body");
    }),
  );

  it.effect("uses frozen eval-trial arms while resolving other skills normally", () =>
    Effect.gen(function* () {
      yield* reset;
      const service = yield* SkillVariants.SkillVariantService;
      const sql = yield* SqlClient.SqlClient;
      const evaluated = yield* createVariant({
        skillName: "review",
        driver: codex,
        model: "gpt-5.6-sol",
        body: "frozen body",
      });
      const other = yield* createVariant({ skillName: "security", body: "other body" });
      const frozenOff = yield* service.mutate({
        action: "set-off",
        skillName: "review",
        driver: codex,
        model: "gpt-5.6-mini",
      });
      yield* service.mutate({ action: "edit", ruleId: evaluated.ruleId, body: "new live body" });

      const configValue: SkillEvalRunConfig = {
        skillName: "review",
        projectId: ProjectId.make("project-eval"),
        candidate: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
        arms: [
          {
            armId: "variant",
            label: "Frozen variant",
            kind: "variant",
            ruleId: evaluated.ruleId,
            role: "treatment",
          },
          { armId: "base", label: "Base", kind: "base", role: "control" },
          { armId: "off", label: "Off", kind: "off", role: "treatment" },
          {
            armId: "off-rule",
            label: "Frozen off rule",
            kind: "off",
            ruleId: frozenOff.ruleId,
            role: "treatment",
          },
        ],
        repeats: 1,
        judge: null,
        judgeSamples: 1,
        concurrency: 1,
        taskIds: ["task-eval"],
        variantRevisions: { [evaluated.ruleId]: 1, [frozenOff.ruleId]: 1 },
      };
      const configJson = encodeEvalConfig(configValue);
      yield* sql`
        INSERT INTO skill_eval_runs (
          eval_run_id, skill_name, config_json, status, error, created_at, started_at, completed_at
        ) VALUES ('eval-run', 'review', ${configJson}, 'running', NULL, '2026-01-01', '2026-01-01', NULL)
      `;
      for (const armId of ["variant", "base", "off", "off-rule"] as const) {
        yield* sql`
          INSERT INTO skill_eval_trials (
            trial_id, eval_run_id, task_id, arm_id, repeat_index, thread_id, run_id,
            status, error, created_at, completed_at
          ) VALUES (
            ${`trial-${armId}`}, 'eval-run', 'task-eval', ${armId}, 0, ${`thread-${armId}`}, NULL,
            'pending', NULL, '2026-01-01', NULL
          )
        `;
      }

      const resolveArm = (armId: "variant" | "base" | "off" | "off-rule") =>
        service.resolvePolicy({
          driver: codex,
          model: "GPT-5.6-SOL",
          threadId: ThreadId.make(`thread-${armId}`),
        });

      const variant = yield* resolveArm("variant");
      const variantEntry = variant.entries.find((entry) => entry.skillName === "review");
      assert.equal(variantEntry?.origin, "eval-arm");
      assert.equal(variantEntry?.revision, 1);
      const fileSystem = yield* FileSystem.FileSystem;
      assert.isFalse(yield* fileSystem.exists(variantEntry?.variantPath ?? ""));
      yield* service.materialize(variant);
      assert.equal(
        yield* fileSystem.readFileString(variantEntry?.variantPath ?? ""),
        "frozen body",
      );
      assert.equal(
        variant.entries.find((entry) => entry.skillName === "security")?.ruleId,
        other.ruleId,
      );

      const base = yield* resolveArm("base");
      assert.equal(base.entries.find((entry) => entry.skillName === "review")?.mode, "base");
      const off = yield* resolveArm("off");
      assert.deepEqual(
        off.entries.find((entry) => entry.skillName === "review"),
        {
          skillName: "review",
          ruleId: null,
          revision: null,
          mode: "off",
          contentHash: null,
          variantPath: null,
          origin: "eval-arm",
        },
      );
      const offRule = yield* resolveArm("off-rule");
      assert.deepEqual(
        offRule.entries.find((entry) => entry.skillName === "review"),
        {
          skillName: "review",
          ruleId: frozenOff.ruleId,
          revision: 1,
          mode: "off",
          contentHash: null,
          variantPath: null,
          origin: "eval-arm",
        },
      );
    }),
  );
});
