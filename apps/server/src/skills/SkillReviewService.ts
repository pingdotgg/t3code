import {
  defaultSkillEvalArms,
  ProviderDriverKind,
  SKILL_BASE_BODY_MAX_BYTES,
  SkillEvalOperationError,
  SkillEvalValidationError,
  type SkillEvalArm,
  type SkillEvalError,
  type SkillEvalRunConfig,
  type SkillEvalRunControlInput,
  type SkillEvalRunDetail,
  type SkillEvalRunId,
  type SkillEvalRunSummary,
  type SkillEvalTask,
  type SkillEvalTaskMutateInput,
  type SkillModelCell,
  type SkillObservationalSummary,
  type SkillReviewDetail,
  type SkillReviewListItem,
  type SkillsReviewGetInput,
  type SkillsReviewListInput,
  SkillVariantPersistenceError,
  type SkillVariantMutateInput,
  type SkillVariantRule,
  SkillVariantValidationError,
  type SkillVerdict,
  type SkillGating,
  type SkillVariantDelivery,
  type SkillsReadError,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SkillEval from "./SkillEvalService.ts";
import type { ObservationalGroupSummary, ObservationalMode } from "./skillEvalStats.ts";
import * as SkillUsage from "./SkillUsageService.ts";
import * as SkillVariant from "./SkillVariantService.ts";

const MAX_SKILLS = 500;
const MAX_CELLS_PER_SKILL = 24;
const MAX_RULES_PER_SKILL = 200;
const MAX_TASKS_PER_SKILL = 200;
const MAX_RUNS_PER_SKILL = 20;
const MAX_REVISIONS_PER_SKILL = 20;
const MAX_PROJECT_ROOTS = 50;
const WORKSPACE_REFRESH_CONCURRENCY = 4;

interface EvalSkillNameRow {
  readonly skill_name: string;
}

interface CountRow {
  readonly count: number;
}

interface ProjectWorkspaceRootRow {
  readonly workspace_root: string;
}

interface CatalogSkillEntry {
  readonly driver: ProviderDriverKind;
  readonly skill: ServerProviderSkill;
}

interface SkillRecord {
  readonly normalizedName: string;
  skillName: string;
  description: string | null;
  readonly providers: Set<ProviderDriverKind>;
  readonly catalogEntries: Array<CatalogSkillEntry>;
}

interface CellCandidate {
  readonly driver: ProviderDriverKind;
  readonly model: string;
}

interface SkillCapability {
  readonly delivery: SkillVariantDelivery;
  readonly gating: SkillGating;
}

export type SkillReviewRunControlInput =
  | Exclude<SkillEvalRunControlInput, { readonly action: "start" }>
  | {
      readonly action: "start";
      readonly config: Omit<SkillEvalRunConfig, "arms"> & {
        readonly arms?: ReadonlyArray<SkillEvalArm>;
      };
    };

const EMPTY_VERDICT: SkillVerdict = {
  verdict: "not-enough-data",
  reason: "no-evaluations",
  effect: null,
  ciLow: null,
  ciHigh: null,
  pAdjusted: null,
  nTasks: 0,
};

const EMPTY_OBSERVATIONAL: SkillObservationalSummary = {
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
};

const normalizeSkillName = (value: string): string => value.trim().toLowerCase();
const cellKey = (driver: ProviderDriverKind, model: string): string =>
  `${driver}\u0000${model.trim().toLowerCase()}`;
const gatingForDelivery = (delivery: SkillVariantDelivery): SkillGating =>
  delivery === "unsupported" ? "none" : "instruction";

const readEvalError = (operation: string, cause: SkillEvalError): SkillsReadError => {
  if (cause._tag === "SkillEvalNotFoundError" || cause._tag === "SkillEvalOperationError") {
    return cause;
  }
  return new SkillEvalOperationError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}.`,
    cause,
  });
};

const usageReadError = (operation: string, cause: unknown): SkillEvalOperationError =>
  new SkillEvalOperationError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}.`,
    cause,
  });

const variantReadError = (operation: string, cause: unknown): SkillVariantPersistenceError =>
  new SkillVariantPersistenceError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}.`,
    cause,
  });

function ensureSkillRecord(records: Map<string, SkillRecord>, rawName: string): SkillRecord | null {
  const skillName = rawName.trim();
  if (skillName.length === 0) return null;
  const normalizedName = normalizeSkillName(skillName);
  const existing = records.get(normalizedName);
  if (existing !== undefined) return existing;
  const created: SkillRecord = {
    normalizedName,
    skillName,
    description: null,
    providers: new Set(),
    catalogEntries: [],
  };
  records.set(normalizedName, created);
  return created;
}

function catalogSkills(
  provider: ServerProvider,
  projectWorkspaceRoots: ReadonlySet<string>,
): ReadonlyArray<ServerProviderSkill> {
  return [
    ...provider.skills,
    ...(provider.workspaceSnapshots ?? []).flatMap((snapshot) =>
      projectWorkspaceRoots.has(snapshot.cwd) ? snapshot.skills : [],
    ),
  ];
}

function addProviderCatalogs(
  records: Map<string, SkillRecord>,
  providers: ReadonlyArray<ServerProvider>,
  projectWorkspaceRoots: ReadonlySet<string>,
): void {
  for (const provider of providers) {
    const seen = new Set<string>();
    for (const skill of catalogSkills(provider, projectWorkspaceRoots)) {
      const record = ensureSkillRecord(records, skill.name);
      if (record === null) continue;
      if (record.catalogEntries.length === 0) record.skillName = skill.name.trim();
      record.description ??= skill.description ?? skill.shortDescription ?? null;
      record.providers.add(provider.driver);
      const key = `${provider.driver}\u0000${skill.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      record.catalogEntries.push({ driver: provider.driver, skill });
    }
  }
}

function rulesForSkill(
  rules: ReadonlyArray<SkillVariantRule>,
  normalizedName: string,
): ReadonlyArray<SkillVariantRule> {
  return rules.filter((rule) => normalizeSkillName(rule.skillName) === normalizedName);
}

function reviewProviders(
  record: SkillRecord,
  cells: ReadonlyArray<SkillModelCell>,
): ReadonlyArray<ProviderDriverKind> {
  return [...new Set([...record.providers, ...cells.map((cell) => cell.driver)])].toSorted();
}

function mostSpecificRule(
  rules: ReadonlyArray<SkillVariantRule>,
  driver: ProviderDriverKind,
  model: string,
  enabledOnly: boolean,
): SkillVariantRule | null {
  const normalizedModel = model.trim().toLowerCase();
  const live = rules.filter((rule) => rule.deletedAt === null && (!enabledOnly || rule.enabled));
  return (
    live.find(
      (rule) =>
        rule.driver === driver &&
        rule.model !== null &&
        rule.model.trim().toLowerCase() === normalizedModel,
    ) ??
    live.find((rule) => rule.driver === driver && rule.model === null) ??
    live.find((rule) => rule.driver === null && rule.model === null) ??
    null
  );
}

const effectiveRule = (
  rules: ReadonlyArray<SkillVariantRule>,
  driver: ProviderDriverKind,
  model: string,
): SkillVariantRule | null => mostSpecificRule(rules, driver, model, true);

const matchingRule = (
  rules: ReadonlyArray<SkillVariantRule>,
  driver: ProviderDriverKind,
  model: string,
): SkillVariantRule | null => mostSpecificRule(rules, driver, model, false);

function observationMode(mode: SkillModelCell["effectiveMode"]): ObservationalMode {
  switch (mode) {
    case "variant":
      return "variant";
    case "off":
      return "off";
    case "base":
      return "base-available";
  }
}

function observationalSummary(group: ObservationalGroupSummary): SkillObservationalSummary {
  return {
    turns: group.turns,
    activationRate: group.activationRate,
    completionRate: group.completion?.estimate ?? null,
    completionCiLow: group.completion?.low ?? null,
    completionCiHigh: group.completion?.high ?? null,
    revertRate: group.revert?.estimate ?? null,
    revertCiLow: group.revert?.low ?? null,
    revertCiHigh: group.revert?.high ?? null,
    toolFailureRate: group.toolFailureRate,
    medianTokens: group.tokens.median,
    medianDurationMs: group.durationMs.median,
    confounded: true,
  };
}

export function verdictFor(
  latest: SkillEval.LatestSkillEvalVerdict | undefined,
  selectedRule: SkillVariantRule | null,
): SkillVerdict {
  if (latest === undefined) return EMPTY_VERDICT;
  const effectiveMode = selectedRule?.mode ?? "base";
  const matchingArm = latest.config.arms.find((arm) => {
    if (arm.role !== "treatment" || arm.kind !== effectiveMode) return false;
    if (effectiveMode === "base") return selectedRule === null && arm.ruleId === undefined;
    return (
      selectedRule !== null &&
      arm.ruleId === selectedRule.ruleId &&
      latest.config.variantRevisions[selectedRule.ruleId] === selectedRule.revision
    );
  });
  if (matchingArm === undefined) return EMPTY_VERDICT;
  return (
    latest.armVerdicts.find((candidate) => candidate.armId === matchingArm.armId)?.verdict ??
    EMPTY_VERDICT
  );
}

export class SkillReviewService extends Context.Service<
  SkillReviewService,
  {
    readonly list: (
      input?: SkillsReviewListInput,
    ) => Effect.Effect<ReadonlyArray<SkillReviewListItem>, SkillsReadError>;
    readonly get: (
      skillName: string,
      extraModels?: SkillsReviewGetInput["models"],
    ) => Effect.Effect<SkillReviewDetail, SkillsReadError>;
    readonly mutateVariant: (
      input: SkillVariantMutateInput,
    ) => Effect.Effect<SkillVariantRule, SkillVariant.SkillVariantServiceError>;
    readonly mutateVariantAuthorized: <E, R>(
      input: SkillVariantMutateInput,
      authorizationCheck: Effect.Effect<unknown, E, R>,
    ) => Effect.Effect<SkillVariantRule, SkillVariant.SkillVariantServiceError | E, R>;
    readonly mutateTask: (
      input: SkillEvalTaskMutateInput,
    ) => Effect.Effect<SkillEvalTask, SkillEvalError>;
    readonly mutateTaskAuthorized: <E, R>(
      input: SkillEvalTaskMutateInput,
      authorizationCheck: Effect.Effect<unknown, E, R>,
    ) => Effect.Effect<SkillEvalTask, SkillEvalError | E, R>;
    readonly controlRun: (
      input: SkillReviewRunControlInput,
    ) => Effect.Effect<SkillEvalRunSummary, SkillEvalError | SkillVariantPersistenceError>;
    readonly getRun: (
      evalRunId: SkillEvalRunId,
    ) => Effect.Effect<SkillEvalRunDetail, SkillsReadError>;
  }
>()("t3/skills/SkillReviewService") {}

export const layer: Layer.Layer<
  SkillReviewService,
  never,
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | ProviderRegistry.ProviderRegistry
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
  | SkillVariant.SkillVariantService
  | SkillUsage.SkillUsageService
  | SkillEval.SkillEvalService
> = Layer.effect(
  SkillReviewService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const adapterRegistry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const variants = yield* SkillVariant.SkillVariantService;
    const usage = yield* SkillUsage.SkillUsageService;
    const evals = yield* SkillEval.SkillEvalService;

    const loadProviders = Effect.fn("SkillReviewService.loadProviders")(
      () => providerRegistry.getProviders,
    );

    const projectWorkspaceRoots = Effect.fn("SkillReviewService.projectWorkspaceRoots")(
      function* () {
        const rows = yield* sql<ProjectWorkspaceRootRow>`
          SELECT project.workspace_root
          FROM projection_projects AS project
          WHERE project.deleted_at IS NULL
          ORDER BY MAX(
            project.updated_at,
            COALESCE(
              (
                SELECT MAX(thread.updated_at)
                FROM orchestration_v2_projection_threads AS thread
                WHERE thread.project_id = project.project_id
                  AND thread.deleted_at IS NULL
              ),
              project.updated_at
            )
          ) DESC,
          project.project_id ASC
          LIMIT ${MAX_PROJECT_ROOTS}
        `.pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError((cause) => usageReadError("list project workspace roots", cause)),
        );
        return rows.map((row) => row.workspace_root);
      },
    );

    const loadCatalogs = Effect.fn("SkillReviewService.loadCatalogs")(function* (refresh: boolean) {
      const [providers, workspaceRoots] = yield* Effect.all(
        [loadProviders(), projectWorkspaceRoots()],
        { concurrency: 2 },
      );
      if (refresh) {
        const targets = workspaceRoots.flatMap((cwd) =>
          providers
            .filter((provider) => provider.enabled)
            .map((provider) => ({ instanceId: provider.instanceId, cwd })),
        );
        yield* Effect.forEach(targets, providerRegistry.refreshWorkspaceSnapshot, {
          concurrency: WORKSPACE_REFRESH_CONCURRENCY,
          discard: true,
        });
      }
      return {
        providers: refresh ? yield* loadProviders() : providers,
        projectWorkspaceRoots: new Set(workspaceRoots),
      };
    });

    const capabilityByDriver = Effect.fn("SkillReviewService.capabilityByDriver")(function* (
      providers: ReadonlyArray<ServerProvider>,
    ) {
      const capabilitiesByDriver = new Map<ProviderDriverKind, SkillCapability>();
      for (const provider of providers) {
        if (capabilitiesByDriver.has(provider.driver)) continue;
        const getCapabilities =
          adapterRegistry.getMetadata === undefined
            ? adapterRegistry
                .get(provider.instanceId)
                .pipe(Effect.flatMap((adapter) => adapter.getCapabilities()))
            : adapterRegistry
                .getMetadata(provider.instanceId)
                .pipe(Effect.map((metadata) => metadata.capabilities));
        const capabilities = yield* getCapabilities.pipe(Effect.orElseSucceed(() => null));
        if (capabilities !== null) {
          const delivery = capabilities.skillVariantDelivery;
          capabilitiesByDriver.set(provider.driver, {
            delivery,
            gating: capabilities.skillGating ?? gatingForDelivery(delivery),
          });
        }
      }
      return capabilitiesByDriver;
    });

    const evalSkillNames = Effect.fn("SkillReviewService.evalSkillNames")(function* () {
      const rows = yield* sql<EvalSkillNameRow>`
        SELECT skill_name
        FROM (
          SELECT skill_name FROM skill_eval_tasks
          UNION
          SELECT skill_name FROM skill_eval_runs
        )
        ORDER BY skill_name
        LIMIT ${MAX_SKILLS}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => usageReadError("list skill evaluation names", cause)),
      );
      return rows.map((row) => row.skill_name);
    });

    const readBaseBody = Effect.fn("SkillReviewService.readBaseBody")(function* (
      record: SkillRecord,
      driver: ProviderDriverKind | null | undefined,
    ) {
      const entry =
        (driver === null || driver === undefined
          ? undefined
          : record.catalogEntries.find((candidate) => candidate.driver === driver)) ??
        record.catalogEntries[0];
      if (entry === undefined) {
        return yield* new SkillVariantValidationError({
          message: `Base skill '${record.skillName}' was not found in the provider skill catalog. Refresh the skill catalog and try again.`,
        });
      }
      const path = entry.skill.path;
      return yield* Effect.gen(function* () {
        const stat = yield* fileSystem.stat(path);
        if (Number(stat.size) > SKILL_BASE_BODY_MAX_BYTES) {
          return yield* new SkillVariantValidationError({
            message: `Base skill bodies are limited to ${SKILL_BASE_BODY_MAX_BYTES} bytes.`,
          });
        }
        const body = yield* fileSystem.readFileString(path);
        if (Buffer.byteLength(body, "utf8") > SKILL_BASE_BODY_MAX_BYTES) {
          return yield* new SkillVariantValidationError({
            message: `Base skill bodies are limited to ${SKILL_BASE_BODY_MAX_BYTES} bytes.`,
          });
        }
        return body;
      }).pipe(
        Effect.mapError((cause) =>
          cause._tag === "SkillVariantValidationError"
            ? cause
            : variantReadError("read a base skill body", cause),
        ),
      );
    });

    const candidatesFor = (
      normalizedName: string,
      providers: ReadonlyArray<ServerProvider>,
      rules: ReadonlyArray<SkillVariantRule>,
      turns: ReadonlyArray<SkillUsage.SkillTurnRecord>,
      observations: ReadonlyArray<ObservationalGroupSummary>,
      latestVerdicts: ReadonlyArray<SkillEval.LatestSkillEvalVerdict>,
      extraModels: SkillsReviewGetInput["models"] = [],
    ): ReadonlyArray<CellCandidate> => {
      const candidates = new Map<string, CellCandidate>();
      const add = (driver: ProviderDriverKind, rawModel: string) => {
        const model = rawModel.trim();
        if (model.length === 0) return;
        const key = cellKey(driver, model);
        if (!candidates.has(key)) candidates.set(key, { driver, model });
      };
      const providerModels = providers.flatMap((provider) =>
        provider.models.map((model) => ({ driver: provider.driver, model: model.slug })),
      );

      for (const rule of rules) {
        if (rule.driver !== null && rule.model !== null) {
          add(rule.driver, rule.model);
          continue;
        }
        for (const candidate of providerModels) {
          if (rule.driver === null || rule.driver === candidate.driver) {
            add(candidate.driver, candidate.model);
          }
        }
      }
      for (const turn of turns) {
        const appears =
          turn.resolution.entries.some(
            (entry) => normalizeSkillName(entry.skillName) === normalizedName,
          ) || turn.available.some((skill) => normalizeSkillName(skill.name) === normalizedName);
        if (appears) add(turn.driver, turn.model);
      }
      for (const observation of observations) {
        add(ProviderDriverKind.make(observation.driver), observation.model);
      }
      for (const latest of latestVerdicts) add(latest.driver, latest.model);
      for (const extra of extraModels) add(extra.driver, extra.model);

      return [...candidates.values()]
        .toSorted(
          (left, right) =>
            left.driver.localeCompare(right.driver) ||
            left.model.localeCompare(right.model, undefined, { sensitivity: "base" }),
        )
        .slice(0, MAX_CELLS_PER_SKILL);
    };

    const cellsFor = (input: {
      readonly record: SkillRecord;
      readonly providers: ReadonlyArray<ServerProvider>;
      readonly rules: ReadonlyArray<SkillVariantRule>;
      readonly turns: ReadonlyArray<SkillUsage.SkillTurnRecord>;
      readonly observations: ReadonlyArray<ObservationalGroupSummary>;
      readonly latestVerdicts: ReadonlyArray<SkillEval.LatestSkillEvalVerdict>;
      readonly capabilities: ReadonlyMap<ProviderDriverKind, SkillCapability>;
      readonly extraModels?: SkillsReviewGetInput["models"];
    }): ReadonlyArray<SkillModelCell> => {
      const observations = new Map(
        input.observations.map(
          (group) =>
            [
              `${cellKey(ProviderDriverKind.make(group.driver), group.model)}\u0000${group.mode}`,
              group,
            ] as const,
        ),
      );
      const latest = new Map(
        input.latestVerdicts.map(
          (verdict) => [cellKey(verdict.driver, verdict.model), verdict] as const,
        ),
      );
      return candidatesFor(
        input.record.normalizedName,
        input.providers,
        input.rules,
        input.turns,
        input.observations,
        input.latestVerdicts,
        input.extraModels,
      ).map((candidate) => {
        const selected = effectiveRule(input.rules, candidate.driver, candidate.model);
        const matching = matchingRule(input.rules, candidate.driver, candidate.model);
        const effectiveMode = selected?.mode ?? "base";
        const observed = observations.get(
          `${cellKey(candidate.driver, candidate.model)}\u0000${observationMode(effectiveMode)}`,
        );
        const persistedDelivery = input.turns.find(
          (turn) => cellKey(turn.driver, turn.model) === cellKey(candidate.driver, candidate.model),
        )?.delivery;
        const capability = input.capabilities.get(candidate.driver);
        const delivery = capability?.delivery ?? persistedDelivery ?? "unsupported";
        return {
          driver: candidate.driver,
          model: candidate.model,
          delivery,
          gating: capability?.gating ?? gatingForDelivery(delivery),
          effectiveMode,
          ruleId: selected?.ruleId ?? null,
          matchingRuleId: matching?.ruleId ?? null,
          verdict: verdictFor(latest.get(cellKey(candidate.driver, candidate.model)), selected),
          observational:
            observed === undefined ? EMPTY_OBSERVATIONAL : observationalSummary(observed),
        } satisfies SkillModelCell;
      });
    };

    const evidenceFor = Effect.fn("SkillReviewService.evidenceFor")(function* (input: {
      readonly record: SkillRecord;
      readonly providers: ReadonlyArray<ServerProvider>;
      readonly rules: ReadonlyArray<SkillVariantRule>;
      readonly turns?: ReadonlyArray<SkillUsage.SkillTurnRecord>;
      readonly capabilities: ReadonlyMap<ProviderDriverKind, SkillCapability>;
      readonly extraModels?: SkillsReviewGetInput["models"];
    }) {
      const [turns, observations, latestVerdicts] = yield* Effect.all(
        [
          input.turns === undefined
            ? usage
                .listTurns({ skillName: input.record.skillName, limit: 500 })
                .pipe(Effect.mapError((cause) => usageReadError("list skill usage turns", cause)))
            : Effect.succeed(input.turns),
          usage
            .observational({ skillName: input.record.skillName })
            .pipe(Effect.mapError((cause) => usageReadError("summarize skill usage", cause))),
          evals
            .latestVerdicts(input.record.skillName)
            .pipe(
              Effect.mapError((cause) => readEvalError("load skill evaluation verdicts", cause)),
            ),
        ],
        { concurrency: 3 },
      );
      const cells = cellsFor({
        record: input.record,
        providers: input.providers,
        rules: input.rules,
        turns,
        observations,
        latestVerdicts,
        capabilities: input.capabilities,
        extraModels: input.extraModels,
      });
      return { turns, observations, latestVerdicts, cells };
    });

    const evalCounts = Effect.fn("SkillReviewService.evalCounts")(function* (skillName: string) {
      const normalized = normalizeSkillName(skillName);
      const [taskRows, runRows] = yield* Effect.all(
        [
          sql<CountRow>`SELECT COUNT(*) AS count FROM skill_eval_tasks WHERE skill_name = ${normalized}`,
          sql<CountRow>`SELECT COUNT(*) AS count FROM skill_eval_runs WHERE skill_name = ${normalized}`,
        ],
        { concurrency: 2 },
      ).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => usageReadError("count skill evaluation history", cause)),
      );
      return { taskCount: taskRows[0]?.count ?? 0, runCount: runRows[0]?.count ?? 0 };
    });

    const list = Effect.fn("SkillReviewService.list")(function* (input?: SkillsReviewListInput) {
      const [catalogs, rules, turns, evalNames] = yield* Effect.all(
        [
          loadCatalogs(input?.refresh === true),
          variants.list(),
          usage
            .listTurns({ limit: 500 })
            .pipe(Effect.mapError((cause) => usageReadError("list skill usage turns", cause))),
          evalSkillNames(),
        ],
        { concurrency: 4 },
      );
      const { providers, projectWorkspaceRoots } = catalogs;
      const records = new Map<string, SkillRecord>();
      addProviderCatalogs(records, providers, projectWorkspaceRoots);
      for (const rule of rules) {
        const record = ensureSkillRecord(records, rule.skillName);
        if (record !== null && rule.driver !== null) record.providers.add(rule.driver);
      }
      for (const turn of turns) {
        for (const entry of turn.resolution.entries) {
          ensureSkillRecord(records, entry.skillName)?.providers.add(turn.driver);
        }
        for (const skill of turn.available) {
          ensureSkillRecord(records, skill.name)?.providers.add(turn.driver);
        }
      }
      for (const skillName of evalNames) ensureSkillRecord(records, skillName);
      const capabilities = yield* capabilityByDriver(providers);
      const selected = [...records.values()]
        .toSorted((left, right) => left.normalizedName.localeCompare(right.normalizedName))
        .slice(0, MAX_SKILLS);
      return yield* Effect.forEach(
        selected,
        (record) =>
          evidenceFor({
            record,
            providers,
            rules: rulesForSkill(rules, record.normalizedName),
            turns,
            capabilities,
          }).pipe(
            Effect.map(
              ({ cells }) =>
                ({
                  skillName: record.skillName,
                  description: record.description,
                  providers: reviewProviders(record, cells),
                  cells,
                }) satisfies SkillReviewListItem,
            ),
          ),
        { concurrency: 4 },
      );
    });

    const get = Effect.fn("SkillReviewService.get")(function* (
      skillName: string,
      extraModels?: SkillsReviewGetInput["models"],
    ) {
      const [catalogs, allRules] = yield* Effect.all([loadCatalogs(false), variants.list()], {
        concurrency: 2,
      });
      const { providers, projectWorkspaceRoots } = catalogs;
      const records = new Map<string, SkillRecord>();
      addProviderCatalogs(records, providers, projectWorkspaceRoots);
      const record = ensureSkillRecord(records, skillName);
      if (record === null) {
        return yield* new SkillEvalValidationError({ message: "Skill name cannot be empty." }).pipe(
          Effect.mapError((cause) => readEvalError("load a skill review", cause)),
        );
      }
      const rules = rulesForSkill(allRules, record.normalizedName);
      for (const rule of rules) {
        if (rule.driver !== null) record.providers.add(rule.driver);
      }
      const capabilities = yield* capabilityByDriver(providers);
      const detailRules = rules.slice(0, MAX_RULES_PER_SKILL);
      const [{ cells }, tasks, runs, counts, revisionGroups] = yield* Effect.all(
        [
          evidenceFor({ record, providers, rules, capabilities, extraModels }),
          evals
            .listTasks({
              skillName: record.skillName,
              includeArchived: true,
              limit: MAX_TASKS_PER_SKILL,
            })
            .pipe(Effect.mapError((cause) => readEvalError("list skill evaluation tasks", cause))),
          evals
            .listRuns(record.skillName, MAX_RUNS_PER_SKILL)
            .pipe(Effect.mapError((cause) => readEvalError("list skill evaluation runs", cause))),
          evalCounts(record.skillName),
          Effect.forEach(
            detailRules,
            (rule) => variants.listRevisions(rule.ruleId, MAX_REVISIONS_PER_SKILL),
            { concurrency: 4 },
          ),
        ],
        { concurrency: 5 },
      );
      const revisions = revisionGroups
        .flat()
        .toSorted(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || right.revision - left.revision,
        )
        .slice(0, MAX_REVISIONS_PER_SKILL);
      return {
        skillName: record.skillName,
        description: record.description,
        providers: reviewProviders(record, cells),
        rules: detailRules,
        revisions,
        tasks: tasks.slice(0, MAX_TASKS_PER_SKILL),
        runs: runs.slice(0, MAX_RUNS_PER_SKILL),
        ruleCount: rules.length,
        taskCount: counts.taskCount,
        runCount: counts.runCount,
        cells,
      } satisfies SkillReviewDetail;
    });

    const mutateVariantWithAuthorization = Effect.fn(
      "SkillReviewService.mutateVariantWithAuthorization",
    )(function* <E, R>(
      input: SkillVariantMutateInput,
      authorizationCheck: Effect.Effect<unknown, E, R>,
    ) {
      if (
        input.action !== "fork" ||
        input.body !== undefined ||
        (input.forkedFromRuleId !== undefined && input.forkedFromRuleId !== null)
      ) {
        yield* authorizationCheck;
        return yield* variants.mutate(input);
      }
      const { providers, projectWorkspaceRoots } = yield* loadCatalogs(false).pipe(
        Effect.mapError((cause) => variantReadError("load provider skill catalogs", cause)),
      );
      const records = new Map<string, SkillRecord>();
      addProviderCatalogs(records, providers, projectWorkspaceRoots);
      const record = records.get(normalizeSkillName(input.skillName));
      if (record === undefined) {
        return yield* new SkillVariantValidationError({
          message: `Base skill '${input.skillName}' was not found in the provider skill catalog. Refresh the skill catalog and try again.`,
        });
      }
      const body = yield* readBaseBody(record, input.driver);
      yield* authorizationCheck;
      return yield* variants.mutate({ ...input, body });
    });
    const mutateVariant = Effect.fn("SkillReviewService.mutateVariant")(
      (input: SkillVariantMutateInput) => mutateVariantWithAuthorization(input, Effect.void),
    );

    const mutateTaskWithAuthorization = Effect.fn("SkillReviewService.mutateTaskWithAuthorization")(
      function* <E, R>(
        input: SkillEvalTaskMutateInput,
        authorizationCheck: Effect.Effect<unknown, E, R>,
      ) {
        yield* authorizationCheck;
        return yield* evals.mutateTask(input);
      },
    );
    const mutateTask = Effect.fn("SkillReviewService.mutateTask")(
      (input: SkillEvalTaskMutateInput) => mutateTaskWithAuthorization(input, Effect.void),
    );

    const controlRun = Effect.fn("SkillReviewService.controlRun")(function* (
      input: SkillReviewRunControlInput,
    ) {
      if (input.action !== "start" || input.config.arms !== undefined) {
        return yield* evals.control(input as SkillEvalRunControlInput);
      }
      const providers = yield* loadProviders();
      const provider = providers.find(
        (candidate) => candidate.instanceId === input.config.candidate.instanceId,
      );
      if (provider === undefined) {
        return yield* new SkillEvalValidationError({
          message: `Provider '${input.config.candidate.instanceId}' was not found.`,
        });
      }
      const rules = rulesForSkill(
        yield* variants.list(),
        normalizeSkillName(input.config.skillName),
      );
      const selected = effectiveRule(rules, provider.driver, input.config.candidate.model);
      const arms = defaultSkillEvalArms(
        selected === null
          ? { effectiveMode: "base", ruleId: null }
          : { effectiveMode: selected.mode, ruleId: selected.ruleId },
      );
      return yield* evals.control({
        action: "start",
        config: {
          ...input.config,
          arms,
        },
      });
    });

    const getRun = Effect.fn("SkillReviewService.getRun")((evalRunId: SkillEvalRunId) =>
      evals
        .getRun(evalRunId)
        .pipe(Effect.mapError((cause) => readEvalError("load a skill evaluation run", cause))),
    );

    return SkillReviewService.of({
      list,
      get,
      mutateVariant,
      mutateVariantAuthorized: mutateVariantWithAuthorization,
      mutateTask,
      mutateTaskAuthorized: mutateTaskWithAuthorization,
      controlRun,
      getRun,
    });
  }),
);
