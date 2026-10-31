import type {
  ModelSelection,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2Run,
  ProviderDriverKind,
  ServerProviderSkill,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { renderSkillDirectives } from "@t3tools/provider-core/server/skillDirectives";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SkillUsageService from "./SkillUsageService.ts";
import * as SkillVariantService from "./SkillVariantService.ts";

export interface PreparedSkillPolicy {
  readonly hash: string;
  readonly entries: ReadonlyArray<{
    readonly skillName: string;
    readonly mode: "variant" | "off";
    readonly variantPath: string | null;
  }>;
}

export interface PreparedSkillTurn {
  readonly skillPolicy: PreparedSkillPolicy;
  readonly skillDirectives: {
    readonly text: string;
    readonly hash: string;
  };
}

export interface SkillTurnPreparationInput {
  readonly run: Pick<OrchestrationV2Run, "id" | "threadId">;
  readonly session: {
    readonly driver: ProviderDriverKind;
    readonly providerSession: {
      readonly capabilities: Pick<OrchestrationV2ProviderCapabilities, "skillVariantDelivery">;
    };
  };
  readonly modelSelection: ModelSelection;
  readonly cwd: string | null;
}

interface ProjectWorkspaceRootRow {
  readonly workspace_root: string;
}

interface EvaluationTrialRow {
  readonly found: number;
}

const SkillTurnPreparationStage = Schema.Literals([
  "trial-identification",
  "variant-resolution",
  "materialization",
  "provider-catalog",
  "turn-start-recording",
]);
type SkillTurnPreparationStage = typeof SkillTurnPreparationStage.Type;

export class SkillTurnPreparationError extends Schema.TaggedError<SkillTurnPreparationError>()(
  "SkillTurnPreparationError",
  {
    runId: Schema.String,
    stage: SkillTurnPreparationStage,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Skill evaluation preparation failed during ${this.stage}.`;
  }
}

export class SkillTurnPreparation extends Context.Service<
  SkillTurnPreparation,
  {
    readonly prepare: (
      input: SkillTurnPreparationInput,
    ) => Effect.Effect<PreparedSkillTurn | undefined, SkillTurnPreparationError>;
  }
>()("t3/skills/SkillTurnPreparation") {}

export const layer = Layer.effect(
  SkillTurnPreparation,
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const skillUsage = yield* SkillUsageService.SkillUsageService;
    const skillVariants = yield* SkillVariantService.SkillVariantService;
    const sql = yield* SqlClient.SqlClient;
    const path = yield* Path.Path;

    const projectWorkspaceRoot = Effect.fn("SkillTurnPreparation.projectWorkspaceRoot")(function* (
      threadId: OrchestrationV2Run["threadId"],
    ) {
      const rows = yield* sql<ProjectWorkspaceRootRow>`
        SELECT project.workspace_root
        FROM orchestration_v2_projection_threads AS thread
        JOIN projection_projects AS project ON project.project_id = thread.project_id
        WHERE thread.thread_id = ${threadId}
          AND project.deleted_at IS NULL
        LIMIT 1
      `.pipe(NodeSqliteClient.readOnly);
      return rows[0]?.workspace_root ?? null;
    });

    const isEvaluationTrial = Effect.fn("SkillTurnPreparation.isEvaluationTrial")(function* (
      threadId: OrchestrationV2Run["threadId"],
    ) {
      const rows = yield* sql<EvaluationTrialRow>`
        SELECT 1 AS found
        FROM skill_eval_trials
        WHERE thread_id = ${threadId}
        LIMIT 1
      `.pipe(NodeSqliteClient.readOnly);
      return rows.length > 0;
    });

    const prepareStage = <A, E, R>(
      input: SkillTurnPreparationInput,
      stage: SkillTurnPreparationStage,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, SkillTurnPreparationError, R> =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.fail(
                new SkillTurnPreparationError({
                  runId: input.run.id,
                  stage,
                  cause,
                }),
              ),
        ),
      );

    const rebaseProjectSkills = (
      skills: ReadonlyArray<ServerProviderSkill>,
      projectRoot: string,
      cwd: string,
    ) =>
      skills.map((skill) => {
        const relative = path.relative(projectRoot, skill.path);
        return relative !== "" && !path.isAbsolute(relative) && !/^\.\.(?:[\\/]|$)/.test(relative)
          ? { ...skill, path: path.resolve(cwd, relative) }
          : skill;
      });

    const prepareUnsafe = Effect.fn("SkillTurnPreparation.prepareUnsafe")(function* (
      input: SkillTurnPreparationInput,
      strict: boolean,
    ) {
      const resolution = yield* prepareStage(
        input,
        "variant-resolution",
        skillVariants.resolvePolicy({
          driver: input.session.driver,
          model: input.modelSelection.model,
          threadId: input.run.threadId,
        }),
      );
      yield* prepareStage(input, "materialization", skillVariants.materialize(resolution));
      const providers = yield* prepareStage(
        input,
        "provider-catalog",
        providerRegistry.getProviders,
      );
      const provider = providers.find(
        (candidate) => candidate.instanceId === input.modelSelection.instanceId,
      );
      if (strict && provider === undefined) {
        return yield* new SkillTurnPreparationError({
          runId: input.run.id,
          stage: "provider-catalog",
          cause: new Error(
            `Provider instance '${input.modelSelection.instanceId}' was not found in the loaded catalog.`,
          ),
        });
      }
      const exactWorkspaceSkills = provider?.workspaceSnapshots?.find(
        (snapshot) => snapshot.cwd === input.cwd,
      )?.skills;
      let workspaceSkills = exactWorkspaceSkills;
      if (workspaceSkills === undefined && provider !== undefined && input.cwd !== null) {
        const projectRoot = yield* prepareStage(
          input,
          "provider-catalog",
          projectWorkspaceRoot(input.run.threadId),
        );
        const projectSkills = provider.workspaceSnapshots?.find(
          (snapshot) => snapshot.cwd === projectRoot,
        )?.skills;
        if (projectRoot !== null && projectSkills !== undefined) {
          workspaceSkills = rebaseProjectSkills(projectSkills, projectRoot, input.cwd);
        }
      }
      const available = (workspaceSkills ?? provider?.skills ?? [])
        .filter((skill) => skill.enabled)
        .map((skill) => ({ name: skill.name, path: skill.path }));

      yield* prepareStage(
        input,
        "turn-start-recording",
        skillUsage.recordTurnStart({
          runId: input.run.id,
          threadId: input.run.threadId,
          instanceId: input.modelSelection.instanceId,
          driver: input.session.driver,
          model: input.modelSelection.model,
          delivery: input.session.providerSession.capabilities.skillVariantDelivery,
          resolution,
          available,
        }),
      );

      if (input.session.providerSession.capabilities.skillVariantDelivery === "unsupported") {
        return undefined;
      }

      const entries = resolution.entries.flatMap((entry) =>
        entry.mode === "off" || (entry.mode === "variant" && entry.variantPath !== null)
          ? [
              {
                skillName: entry.skillName,
                mode: entry.mode,
                variantPath: entry.variantPath,
              } as const,
            ]
          : [],
      );
      const text = renderSkillDirectives(entries);
      return text.length === 0
        ? undefined
        : {
            skillPolicy: { hash: resolution.hash, entries },
            skillDirectives: { text, hash: resolution.hash },
          };
    });

    const prepare = Effect.fn("SkillTurnPreparation.prepare")(function* (
      input: SkillTurnPreparationInput,
    ) {
      const strict = yield* prepareStage(
        input,
        "trial-identification",
        isEvaluationTrial(input.run.threadId),
      );
      if (strict) return yield* prepareUnsafe(input, true);
      return yield* prepareUnsafe(input, false).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Failed to prepare model-specific skills for provider turn.", {
                runId: input.run.id,
                cause,
              }).pipe(Effect.as(undefined)),
        ),
      );
    });

    return { prepare };
  }),
);

const layerWithoutProviderCatalog = Layer.effect(
  SkillTurnPreparation,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const prepare = Effect.fn("SkillTurnPreparation.prepareWithoutProviderCatalog")(function* (
      input: SkillTurnPreparationInput,
    ) {
      const rows = yield* sql<EvaluationTrialRow>`
        SELECT 1 AS found
        FROM skill_eval_trials
        WHERE thread_id = ${input.run.threadId}
        LIMIT 1
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.fail(
                new SkillTurnPreparationError({
                  runId: input.run.id,
                  stage: "trial-identification",
                  cause,
                }),
              ),
        ),
      );
      if (rows.length === 0) return undefined;
      return yield* new SkillTurnPreparationError({
        runId: input.run.id,
        stage: "provider-catalog",
        cause: new Error("The provider skill catalog is unavailable."),
      });
    });
    return { prepare };
  }),
);

export const layerOptionalProviderRegistry: Layer.Layer<
  SkillTurnPreparation,
  never,
  | SkillUsageService.SkillUsageService
  | SkillVariantService.SkillVariantService
  | SqlClient.SqlClient
  | Path.Path
> = Layer.unwrap(
  Effect.serviceOption(ProviderRegistry.ProviderRegistry).pipe(
    Effect.map(
      Option.match({
        onNone: () => layerWithoutProviderCatalog,
        onSome: (providerRegistry) =>
          layer.pipe(
            Layer.provide(Layer.succeed(ProviderRegistry.ProviderRegistry, providerRegistry)),
          ),
      }),
    ),
  ),
);
