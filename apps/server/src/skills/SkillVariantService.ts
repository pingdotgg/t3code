// @effect-diagnostics-next-line nodeBuiltinImport:off -- Content hashes are computed in pure resolution helpers; Effect's Crypto digest is effectful.
import * as NodeCrypto from "node:crypto";

import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import {
  ProviderDriverKind,
  SKILL_VARIANT_BODY_MAX_BYTES,
  SkillEvalRunConfig,
  SkillVariantConflictError,
  SkillVariantNotFoundError,
  SkillVariantPersistenceError,
  SkillVariantRule,
  type SkillVariantRuleId,
  SkillVariantRevision,
  type SkillVariantRevisionAction,
  SkillVariantValidationError,
  type SkillTurnResolution,
  SkillTurnResolutionEntry,
  type SkillVariantMutateInput,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../config.ts";

export type SkillVariantServiceError =
  | SkillVariantNotFoundError
  | SkillVariantConflictError
  | SkillVariantValidationError
  | SkillVariantPersistenceError;

interface SkillVariantRuleRow {
  readonly rule_id: string;
  readonly skill_name: string;
  readonly driver: string | null;
  readonly model: string | null;
  readonly mode: "variant" | "off";
  readonly body: string | null;
  readonly enabled: number;
  readonly forked_from_rule_id: string | null;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

interface SkillVariantRevisionRow {
  readonly rule_id: string;
  readonly revision: number;
  readonly action: SkillVariantRevisionAction;
  readonly mode: "variant" | "off";
  readonly body: string | null;
  readonly enabled: number;
  readonly deleted: number;
  readonly created_at: string;
}

interface EvalTrialArmRow {
  readonly arm_id: string;
  readonly config_json: string;
}

const decodeRule = Schema.decodeUnknownEffect(SkillVariantRule);
const decodeRevision = Schema.decodeUnknownEffect(SkillVariantRevision);
const decodeEvalConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(SkillEvalRunConfig));
const encodeResolutionEntries = Schema.encodeUnknownSync(
  Schema.fromJsonString(Schema.Array(SkillTurnResolutionEntry)),
);
const isSkillVariantNotFoundError = Schema.is(SkillVariantNotFoundError);
const isSkillVariantConflictError = Schema.is(SkillVariantConflictError);
const isSkillVariantValidationError = Schema.is(SkillVariantValidationError);
const isSkillVariantPersistenceError = Schema.is(SkillVariantPersistenceError);

const normalizeSkillName = (skillName: string) => skillName.trim().toLowerCase();
const normalizeDriver = (driver: ProviderDriverKind | null | undefined) =>
  driver === null || driver === undefined ? null : driver;
const normalizeModel = (model: string | null | undefined) =>
  model === null || model === undefined ? null : model.trim().toLowerCase();
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

function persistenceError(operation: string, cause: unknown) {
  return new SkillVariantPersistenceError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}.`,
    cause,
  });
}

function preservesVariantError(cause: unknown): SkillVariantServiceError {
  if (
    isSkillVariantNotFoundError(cause) ||
    isSkillVariantConflictError(cause) ||
    isSkillVariantValidationError(cause) ||
    isSkillVariantPersistenceError(cause)
  ) {
    return cause;
  }
  return persistenceError("update skill variants", cause);
}

function targetConflict(
  target: {
    readonly skillName: string;
    readonly driver: string | null;
    readonly model: string | null;
  },
  conflictingRuleId?: string,
) {
  return new SkillVariantConflictError({
    skillName: target.skillName,
    driver: target.driver === null ? null : ProviderDriverKind.make(target.driver),
    model: target.model,
    ...(conflictingRuleId === undefined ? {} : { conflictingRuleId }),
    message: `A live rule already owns ${target.skillName} for this provider and model target.`,
  });
}

function validateBody(body: string, ruleId?: SkillVariantRuleId) {
  const bytes = Buffer.byteLength(body, "utf8");
  return bytes <= SKILL_VARIANT_BODY_MAX_BYTES
    ? Effect.succeed(body)
    : Effect.fail(
        new SkillVariantValidationError({
          message: `Skill variant bodies are limited to ${SKILL_VARIANT_BODY_MAX_BYTES} bytes.`,
          ...(ruleId === undefined ? {} : { ruleId }),
        }),
      );
}

function normalizeTarget(input: {
  readonly skillName: string;
  readonly driver?: ProviderDriverKind | null;
  readonly model?: string | null;
}) {
  const target = {
    skillName: normalizeSkillName(input.skillName),
    driver: normalizeDriver(input.driver),
    model: normalizeModel(input.model),
  };
  if (target.skillName === "") {
    return Effect.fail(new SkillVariantValidationError({ message: "Skill name cannot be empty." }));
  }
  if (target.model !== null && target.driver === null) {
    return Effect.fail(
      new SkillVariantValidationError({
        message: "A model-specific rule must also select a driver.",
      }),
    );
  }
  return Effect.succeed(target);
}

function ruleFromRow(row: SkillVariantRuleRow) {
  return decodeRule({
    ruleId: row.rule_id,
    skillName: row.skill_name,
    driver: row.driver,
    model: row.model,
    mode: row.mode,
    body: row.body,
    enabled: row.enabled !== 0,
    forkedFromRuleId: row.forked_from_rule_id,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }).pipe(Effect.mapError((cause) => persistenceError("decode a skill variant rule", cause)));
}

function revisionFromRow(row: SkillVariantRevisionRow) {
  return decodeRevision({
    ruleId: row.rule_id,
    revision: row.revision,
    action: row.action,
    mode: row.mode,
    body: row.body,
    enabled: row.enabled !== 0,
    deleted: row.deleted !== 0,
    createdAt: row.created_at,
  }).pipe(Effect.mapError((cause) => persistenceError("decode a skill variant revision", cause)));
}

export class SkillVariantService extends Context.Service<
  SkillVariantService,
  {
    readonly list: () => Effect.Effect<
      ReadonlyArray<SkillVariantRule>,
      SkillVariantPersistenceError
    >;
    readonly get: (
      ruleId: SkillVariantRuleId,
    ) => Effect.Effect<SkillVariantRule, SkillVariantNotFoundError | SkillVariantPersistenceError>;
    readonly listRevisions: (
      ruleId: SkillVariantRuleId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<SkillVariantRevision>, SkillVariantPersistenceError>;
    readonly mutate: (
      input: SkillVariantMutateInput,
    ) => Effect.Effect<SkillVariantRule, SkillVariantServiceError>;
    readonly resolvePolicy: (input: {
      readonly driver: ProviderDriverKind;
      readonly model: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<SkillTurnResolution, SkillVariantServiceError>;
    readonly materialize: (
      resolution: SkillTurnResolution,
    ) => Effect.Effect<void, SkillVariantServiceError>;
  }
>()("t3/skills/SkillVariantService") {}

export const layer = Layer.effect(
  SkillVariantService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;

    const selectRule = (ruleId: SkillVariantRuleId) =>
      sql<SkillVariantRuleRow>`
        SELECT
          rule_id,
          skill_name,
          driver,
          model,
          mode,
          body,
          enabled,
          forked_from_rule_id,
          revision,
          created_at,
          updated_at,
          deleted_at
        FROM skill_variant_rules
        WHERE rule_id = ${ruleId}
      `;

    const loadRule = Effect.fn("SkillVariantService.loadRule")(function* (
      ruleId: SkillVariantRuleId,
    ) {
      const rows = yield* selectRule(ruleId).pipe(
        Effect.mapError((cause) => persistenceError("load a skill variant rule", cause)),
      );
      const row = rows[0];
      if (row === undefined) {
        return yield* new SkillVariantNotFoundError({
          ruleId,
          message: `Skill variant rule ${ruleId} was not found.`,
        });
      }
      return yield* ruleFromRow(row);
    });

    const findLiveTarget = Effect.fn("SkillVariantService.findLiveTarget")(function* (target: {
      readonly skillName: string;
      readonly driver: string | null;
      readonly model: string | null;
    }) {
      const rows = yield* sql<SkillVariantRuleRow>`
        SELECT
          rule_id,
          skill_name,
          driver,
          model,
          mode,
          body,
          enabled,
          forked_from_rule_id,
          revision,
          created_at,
          updated_at,
          deleted_at
        FROM skill_variant_rules
        WHERE skill_name = ${target.skillName}
          AND IFNULL(driver, '') = IFNULL(${target.driver}, '')
          AND IFNULL(model, '') = IFNULL(${target.model}, '')
          AND deleted_at IS NULL
        LIMIT 1
      `.pipe(Effect.mapError((cause) => persistenceError("find a skill variant target", cause)));
      return rows[0] === undefined ? null : yield* ruleFromRow(rows[0]);
    });

    const appendRevision = Effect.fn("SkillVariantService.appendRevision")(function* (
      rule: SkillVariantRule,
      action: SkillVariantRevisionAction,
      createdAt: string,
    ) {
      yield* sql`
        INSERT INTO skill_variant_revisions (
          rule_id,
          revision,
          action,
          mode,
          body,
          enabled,
          deleted,
          created_at
        ) VALUES (
          ${rule.ruleId},
          ${rule.revision},
          ${action},
          ${rule.mode},
          ${rule.body},
          ${rule.enabled ? 1 : 0},
          ${rule.deletedAt === null ? 0 : 1},
          ${createdAt}
        )
      `.pipe(
        Effect.mapError((cause) => persistenceError("append a skill variant revision", cause)),
      );
    });

    const insertRule = Effect.fn("SkillVariantService.insertRule")(function* (
      rule: SkillVariantRule,
      action: "create" | "fork" | "set-off" | "set-variant",
    ) {
      yield* sql`
        INSERT INTO skill_variant_rules (
          rule_id,
          skill_name,
          driver,
          model,
          mode,
          body,
          enabled,
          forked_from_rule_id,
          revision,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          ${rule.ruleId},
          ${rule.skillName},
          ${rule.driver},
          ${rule.model},
          ${rule.mode},
          ${rule.body},
          ${rule.enabled ? 1 : 0},
          ${rule.forkedFromRuleId},
          ${rule.revision},
          ${rule.createdAt},
          ${rule.updatedAt},
          ${rule.deletedAt}
        )
      `.pipe(Effect.mapError((cause) => persistenceError("create a skill variant rule", cause)));
      yield* appendRevision(rule, action, rule.updatedAt);
      return rule;
    });

    const updateRule = Effect.fn("SkillVariantService.updateRule")(function* (
      rule: SkillVariantRule,
      action: SkillVariantRevisionAction,
    ) {
      const rows = yield* sql<{ readonly rule_id: string }>`
        UPDATE skill_variant_rules
        SET mode = ${rule.mode},
            body = ${rule.body},
            enabled = ${rule.enabled ? 1 : 0},
            revision = ${rule.revision},
            updated_at = ${rule.updatedAt},
            deleted_at = ${rule.deletedAt}
        WHERE rule_id = ${rule.ruleId}
        RETURNING rule_id
      `.pipe(Effect.mapError((cause) => persistenceError("update a skill variant rule", cause)));
      if (rows.length === 0) {
        return yield* new SkillVariantNotFoundError({
          ruleId: rule.ruleId,
          message: `Skill variant rule ${rule.ruleId} was not found.`,
        });
      }
      yield* appendRevision(rule, action, rule.updatedAt);
      return rule;
    });

    const variantPath = (contentHash: string) =>
      path.join(config.stateDir, "skill-variants", contentHash, "SKILL.md");

    const writeMaterialized = Effect.fn("SkillVariantService.writeMaterialized")(function* (
      body: string,
      contentHash: string,
    ) {
      yield* validateBody(body);
      if (sha256(body) !== contentHash) {
        return yield* new SkillVariantValidationError({
          message: "A resolved skill variant no longer matches its content hash.",
        });
      }
      const targetPath = variantPath(contentHash);
      const exists = yield* fileSystem
        .exists(targetPath)
        .pipe(
          Effect.mapError((cause) =>
            persistenceError("inspect a materialized skill variant", cause),
          ),
        );
      if (exists) return;

      const directory = path.dirname(targetPath);
      yield* fileSystem
        .makeDirectory(directory, { recursive: true })
        .pipe(
          Effect.mapError((cause) => persistenceError("create a skill variant directory", cause)),
        );
      const temporaryPath = path.join(directory, `.SKILL.md.${yield* randomUuidV4}.tmp`);
      yield* Effect.gen(function* () {
        yield* fileSystem.writeFileString(temporaryPath, body);
        yield* fileSystem.rename(temporaryPath, targetPath);
      }).pipe(
        Effect.ensuring(fileSystem.remove(temporaryPath).pipe(Effect.ignore)),
        Effect.mapError((cause) => persistenceError("materialize a skill variant", cause)),
      );
    });

    const materialize = Effect.fn("SkillVariantService.materialize")(function* (
      resolution: SkillTurnResolution,
    ) {
      const materialized = new Set<string>();
      for (const entry of resolution.entries) {
        if (entry.mode !== "variant" || entry.ruleId === null || entry.revision === null) continue;
        if (entry.contentHash === null || entry.variantPath === null) {
          return yield* new SkillVariantValidationError({
            ruleId: entry.ruleId,
            message: "A resolved skill variant is missing its content address.",
          });
        }
        if (entry.variantPath !== variantPath(entry.contentHash)) {
          return yield* new SkillVariantValidationError({
            ruleId: entry.ruleId,
            message: "A resolved skill variant has an invalid materialization path.",
          });
        }
        if (materialized.has(entry.contentHash)) continue;
        const rows = yield* sql<SkillVariantRevisionRow>`
          SELECT rule_id, revision, action, mode, body, enabled, deleted, created_at
          FROM skill_variant_revisions
          WHERE rule_id = ${entry.ruleId} AND revision = ${entry.revision}
          LIMIT 1
        `.pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError((cause) => persistenceError("load a skill variant revision", cause)),
        );
        const revision = rows[0];
        if (revision === undefined || revision.mode !== "variant" || revision.body === null) {
          return yield* new SkillVariantValidationError({
            ruleId: entry.ruleId,
            message: `Resolved revision ${entry.revision} has no variant body.`,
          });
        }
        yield* writeMaterialized(revision.body, entry.contentHash);
        materialized.add(entry.contentHash);
      }
    });

    const list = Effect.fn("SkillVariantService.list")(function* () {
      const rows = yield* sql<SkillVariantRuleRow>`
        SELECT
          rule_id,
          skill_name,
          driver,
          model,
          mode,
          body,
          enabled,
          forked_from_rule_id,
          revision,
          created_at,
          updated_at,
          deleted_at
        FROM skill_variant_rules
        ORDER BY skill_name, IFNULL(driver, ''), IFNULL(model, ''), created_at, rule_id
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => persistenceError("list skill variant rules", cause)),
      );
      return yield* Effect.forEach(rows, ruleFromRow, { concurrency: 1 });
    });

    const get = Effect.fn("SkillVariantService.get")(function* (ruleId: SkillVariantRuleId) {
      return yield* loadRule(ruleId).pipe(NodeSqliteClient.readOnly);
    });

    const listRevisions = Effect.fn("SkillVariantService.listRevisions")(function* (
      ruleId: SkillVariantRuleId,
      limit: number,
    ) {
      const boundedLimit = Math.max(0, Math.min(100, Math.trunc(limit)));
      if (boundedLimit === 0) return [];
      const rows = yield* sql<SkillVariantRevisionRow>`
        SELECT rule_id, revision, action, mode, body, enabled, deleted, created_at
        FROM skill_variant_revisions
        WHERE rule_id = ${ruleId}
        ORDER BY revision DESC
        LIMIT ${boundedLimit}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => persistenceError("list skill variant revisions", cause)),
      );
      return yield* Effect.forEach(rows, revisionFromRow, { concurrency: 1 });
    });

    const mutate = Effect.fn("SkillVariantService.mutate")(function* (
      input: SkillVariantMutateInput,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);

      const mutation = Effect.gen(function* () {
        switch (input.action) {
          case "create": {
            const target = yield* normalizeTarget(input);
            yield* validateBody(input.body);
            const existing = yield* findLiveTarget(target);
            if (existing !== null) return yield* targetConflict(target, existing.ruleId);
            return yield* insertRule(
              yield* ruleFromRow({
                rule_id: yield* randomUuidV4,
                skill_name: target.skillName,
                driver: target.driver,
                model: target.model,
                mode: "variant",
                body: input.body,
                enabled: 1,
                forked_from_rule_id: null,
                revision: 1,
                created_at: now,
                updated_at: now,
                deleted_at: null,
              }),
              "create",
            );
          }
          case "fork": {
            const target = yield* normalizeTarget(input);
            const existing = yield* findLiveTarget(target);
            if (existing !== null) return yield* targetConflict(target, existing.ruleId);
            const parent =
              input.forkedFromRuleId === undefined || input.forkedFromRuleId === null
                ? null
                : yield* loadRule(input.forkedFromRuleId);
            const body = input.body ?? parent?.body;
            if (body === undefined || body === null) {
              return yield* new SkillVariantValidationError({
                message: "Forking from the base skill requires its SKILL.md body.",
              });
            }
            yield* validateBody(body);
            return yield* insertRule(
              yield* ruleFromRow({
                rule_id: yield* randomUuidV4,
                skill_name: target.skillName,
                driver: target.driver,
                model: target.model,
                mode: "variant",
                body,
                enabled: 1,
                forked_from_rule_id: input.forkedFromRuleId ?? null,
                revision: 1,
                created_at: now,
                updated_at: now,
                deleted_at: null,
              }),
              "fork",
            );
          }
          case "edit": {
            const current = yield* loadRule(input.ruleId);
            if (current.deletedAt !== null) {
              return yield* new SkillVariantValidationError({
                ruleId: current.ruleId,
                message: "Restore a deleted rule before editing it.",
              });
            }
            yield* validateBody(input.body, current.ruleId);
            return yield* updateRule(
              {
                ...current,
                mode: "variant",
                body: input.body,
                revision: current.revision + 1,
                updatedAt: now,
              },
              "edit",
            );
          }
          case "enable":
          case "disable": {
            const current = yield* loadRule(input.ruleId);
            if (current.deletedAt !== null) {
              return yield* new SkillVariantValidationError({
                ruleId: current.ruleId,
                message: "Restore a deleted rule before changing whether it is enabled.",
              });
            }
            return yield* updateRule(
              {
                ...current,
                enabled: input.action === "enable",
                revision: current.revision + 1,
                updatedAt: now,
              },
              input.action,
            );
          }
          case "revert": {
            const current = yield* loadRule(input.ruleId);
            if (current.deletedAt !== null || current.mode !== "variant") {
              return yield* new SkillVariantValidationError({
                ruleId: current.ruleId,
                message: "Only a live variant rule can revert its previous body.",
              });
            }
            const rows = yield* sql<SkillVariantRevisionRow>`
              SELECT rule_id, revision, action, mode, body, enabled, deleted, created_at
              FROM skill_variant_revisions
              WHERE rule_id = ${current.ruleId} AND revision < ${current.revision}
                AND mode = 'variant' AND body IS NOT NULL AND body != ${current.body}
              ORDER BY revision DESC LIMIT 1
            `.pipe(
              Effect.mapError((cause) =>
                persistenceError("load the previous skill variant revision", cause),
              ),
            );
            const previous = rows[0];
            if (previous === undefined || previous.mode !== "variant" || previous.body === null) {
              return yield* new SkillVariantValidationError({
                ruleId: current.ruleId,
                message: "This rule has no previous variant body to restore.",
              });
            }
            return yield* updateRule(
              {
                ...current,
                body: previous.body,
                revision: current.revision + 1,
                updatedAt: now,
              },
              "revert",
            );
          }
          case "set-off": {
            const target = yield* normalizeTarget(input);
            const current = yield* findLiveTarget(target);
            if (current === null) {
              return yield* insertRule(
                yield* ruleFromRow({
                  rule_id: yield* randomUuidV4,
                  skill_name: target.skillName,
                  driver: target.driver,
                  model: target.model,
                  mode: "off",
                  body: null,
                  enabled: 1,
                  forked_from_rule_id: null,
                  revision: 1,
                  created_at: now,
                  updated_at: now,
                  deleted_at: null,
                }),
                "set-off",
              );
            }
            return yield* updateRule(
              {
                ...current,
                mode: "off",
                body: null,
                enabled: true,
                revision: current.revision + 1,
                updatedAt: now,
              },
              "set-off",
            );
          }
          case "set-variant": {
            const target = yield* normalizeTarget(input);
            yield* validateBody(input.body);
            const current = yield* findLiveTarget(target);
            if (current === null) {
              return yield* insertRule(
                yield* ruleFromRow({
                  rule_id: yield* randomUuidV4,
                  skill_name: target.skillName,
                  driver: target.driver,
                  model: target.model,
                  mode: "variant",
                  body: input.body,
                  enabled: 1,
                  forked_from_rule_id: null,
                  revision: 1,
                  created_at: now,
                  updated_at: now,
                  deleted_at: null,
                }),
                "set-variant",
              );
            }
            return yield* updateRule(
              {
                ...current,
                mode: "variant",
                body: input.body,
                enabled: true,
                revision: current.revision + 1,
                updatedAt: now,
              },
              "set-variant",
            );
          }
          case "delete": {
            const current = yield* loadRule(input.ruleId);
            if (current.deletedAt !== null) {
              return yield* new SkillVariantValidationError({
                ruleId: current.ruleId,
                message: "The rule is already deleted.",
              });
            }
            return yield* updateRule(
              { ...current, revision: current.revision + 1, updatedAt: now, deletedAt: now },
              "delete",
            );
          }
          case "restore": {
            const current = yield* loadRule(input.ruleId);
            if (current.deletedAt === null) {
              return yield* new SkillVariantValidationError({
                ruleId: current.ruleId,
                message: "The rule is already active.",
              });
            }
            const target = {
              skillName: current.skillName,
              driver: current.driver,
              model: current.model,
            };
            const conflict = yield* findLiveTarget(target);
            if (conflict !== null) return yield* targetConflict(target, conflict.ruleId);
            return yield* updateRule(
              { ...current, revision: current.revision + 1, updatedAt: now, deletedAt: null },
              "restore",
            );
          }
        }
      });

      return yield* sql.withTransaction(mutation).pipe(Effect.mapError(preservesVariantError));
    });

    const ruleResolutionEntry = Effect.fn("SkillVariantService.ruleResolutionEntry")(function* (
      rule: SkillVariantRule,
      origin: "rule" | "eval-arm",
    ) {
      if (rule.mode === "off") {
        return {
          skillName: rule.skillName,
          ruleId: rule.ruleId,
          revision: rule.revision,
          mode: "off",
          contentHash: null,
          variantPath: null,
          origin,
        } satisfies SkillTurnResolutionEntry;
      }
      if (rule.body === null) {
        return yield* new SkillVariantValidationError({
          ruleId: rule.ruleId,
          message: "A variant rule is missing its body.",
        });
      }
      const contentHash = sha256(rule.body);
      return {
        skillName: rule.skillName,
        ruleId: rule.ruleId,
        revision: rule.revision,
        mode: "variant",
        contentHash,
        variantPath: variantPath(contentHash),
        origin,
      } satisfies SkillTurnResolutionEntry;
    });

    const resolvePolicy = Effect.fn("SkillVariantService.resolvePolicy")(function* (input: {
      readonly driver: ProviderDriverKind;
      readonly model: string;
      readonly threadId: ThreadId;
    }) {
      const driver = input.driver;
      const model = input.model.toLowerCase();
      const trialRows = yield* sql<EvalTrialArmRow>`
        SELECT trial.arm_id, run.config_json
        FROM skill_eval_trials AS trial
        JOIN skill_eval_runs AS run ON run.eval_run_id = trial.eval_run_id
        WHERE trial.thread_id = ${input.threadId}
        ORDER BY trial.created_at DESC, trial.trial_id DESC
        LIMIT 1
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => persistenceError("load an evaluation trial arm", cause)),
      );

      const entries: SkillTurnResolutionEntry[] = [];
      let evaluatedSkillName: string | null = null;
      const trial = trialRows[0];
      if (trial !== undefined) {
        const evalConfig = yield* decodeEvalConfig(trial.config_json).pipe(
          Effect.mapError((cause) => persistenceError("decode an evaluation run config", cause)),
        );
        const arm = evalConfig.arms.find((candidate) => candidate.armId === trial.arm_id);
        if (arm === undefined) {
          return yield* new SkillVariantValidationError({
            message: `Evaluation arm ${trial.arm_id} is missing from its frozen run config.`,
          });
        }
        evaluatedSkillName = normalizeSkillName(evalConfig.skillName);
        if (arm.kind === "base") {
          entries.push({
            skillName: evaluatedSkillName,
            ruleId: null,
            revision: null,
            mode: "base",
            contentHash: null,
            variantPath: null,
            origin: "eval-arm",
          });
        } else if (arm.kind === "off") {
          if (arm.ruleId === undefined) {
            entries.push({
              skillName: evaluatedSkillName,
              ruleId: null,
              revision: null,
              mode: "off",
              contentHash: null,
              variantPath: null,
              origin: "eval-arm",
            });
          } else {
            const revision = evalConfig.variantRevisions[arm.ruleId];
            if (revision === undefined) {
              return yield* new SkillVariantValidationError({
                ruleId: arm.ruleId,
                message: `Off evaluation arm ${arm.armId} has no frozen revision.`,
              });
            }
            const rows = yield* sql<SkillVariantRevisionRow>`
              SELECT rule_id, revision, action, mode, body, enabled, deleted, created_at
              FROM skill_variant_revisions
              WHERE rule_id = ${arm.ruleId} AND revision = ${revision}
            `.pipe(
              NodeSqliteClient.readOnly,
              Effect.mapError((cause) =>
                persistenceError("load a frozen evaluation off rule", cause),
              ),
            );
            const frozen = rows[0];
            if (frozen === undefined || frozen.mode !== "off") {
              return yield* new SkillVariantValidationError({
                ruleId: arm.ruleId,
                message: `Frozen revision ${revision} is not an off rule.`,
              });
            }
            entries.push({
              skillName: evaluatedSkillName,
              ruleId: arm.ruleId,
              revision,
              mode: "off",
              contentHash: null,
              variantPath: null,
              origin: "eval-arm",
            });
          }
        } else {
          if (arm.ruleId === undefined) {
            return yield* new SkillVariantValidationError({
              message: `Variant evaluation arm ${arm.armId} has no rule id.`,
            });
          }
          const revision = evalConfig.variantRevisions[arm.ruleId];
          if (revision === undefined) {
            return yield* new SkillVariantValidationError({
              ruleId: arm.ruleId,
              message: `Variant evaluation arm ${arm.armId} has no frozen revision.`,
            });
          }
          const rows = yield* sql<SkillVariantRevisionRow>`
            SELECT rule_id, revision, action, mode, body, enabled, deleted, created_at
            FROM skill_variant_revisions
            WHERE rule_id = ${arm.ruleId} AND revision = ${revision}
          `.pipe(
            NodeSqliteClient.readOnly,
            Effect.mapError((cause) => persistenceError("load a frozen evaluation variant", cause)),
          );
          const frozen = rows[0];
          if (frozen === undefined || frozen.mode !== "variant" || frozen.body === null) {
            return yield* new SkillVariantValidationError({
              ruleId: arm.ruleId,
              message: `Frozen revision ${revision} is not an available variant body.`,
            });
          }
          const contentHash = sha256(frozen.body);
          entries.push({
            skillName: evaluatedSkillName,
            ruleId: arm.ruleId,
            revision,
            mode: "variant",
            contentHash,
            variantPath: variantPath(contentHash),
            origin: "eval-arm",
          });
        }
      }

      const rows = yield* sql<SkillVariantRuleRow>`
        SELECT
          rule_id,
          skill_name,
          driver,
          model,
          mode,
          body,
          enabled,
          forked_from_rule_id,
          revision,
          created_at,
          updated_at,
          deleted_at
        FROM skill_variant_rules
        WHERE deleted_at IS NULL
          AND enabled = 1
          AND (driver IS NULL OR driver = ${driver})
          AND (model IS NULL OR LOWER(model) = ${model})
        ORDER BY
          skill_name,
          CASE
            WHEN driver IS NOT NULL AND model IS NOT NULL THEN 2
            WHEN driver IS NOT NULL THEN 1
            ELSE 0
          END DESC,
          updated_at DESC,
          rule_id
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => persistenceError("resolve skill variant rules", cause)),
      );

      const selected = new Set<string>();
      if (evaluatedSkillName !== null) selected.add(evaluatedSkillName);
      for (const row of rows) {
        if (selected.has(row.skill_name)) continue;
        selected.add(row.skill_name);
        entries.push(yield* ruleResolutionEntry(yield* ruleFromRow(row), "rule"));
      }

      entries.sort((left, right) => left.skillName.localeCompare(right.skillName));
      return {
        entries,
        hash: sha256(encodeResolutionEntries(entries)),
      } satisfies SkillTurnResolution;
    });

    return SkillVariantService.of({
      list,
      get,
      listRevisions,
      mutate,
      resolvePolicy,
      materialize,
    });
  }),
);
