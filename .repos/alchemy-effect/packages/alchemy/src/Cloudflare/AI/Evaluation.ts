import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.AI.Evaluation" as const;
type TypeId = typeof TypeId;

export type EvaluationProps = {
  /**
   * The AI Gateway the evaluation runs against. Changing the gateway
   * triggers a replacement.
   */
  gatewayId: string;
  /**
   * Human readable evaluation name. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Evaluations are immutable —
   * changing the name triggers a replacement.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The datasets (saved log filters) the evaluation processes. Usually the
   * `datasetId` attributes of `Dataset` resources on the same
   * gateway. Changing the datasets triggers a replacement.
   */
  datasetIds: string[];
  /**
   * The evaluation types to run (e.g. speed, cost). Discover ids with
   * `listEvaluationTypes` — the mandatory `speed` and `cost` types are
   * account-global constants. Changing the types triggers a replacement.
   */
  evaluationTypeIds: string[];
};

export type EvaluationAttributes = {
  /**
   * Server-generated evaluation identifier. Stable for the lifetime of the
   * evaluation.
   */
  evaluationId: string;
  /**
   * The Cloudflare account the evaluation belongs to.
   */
  accountId: string;
  /**
   * The AI Gateway the evaluation runs against.
   */
  gatewayId: string;
  /**
   * Human readable evaluation name.
   */
  name: string;
  /**
   * The dataset ids the evaluation processes.
   */
  datasetIds: string[];
  /**
   * The evaluation type ids the evaluation runs.
   */
  evaluationTypeIds: string[];
  /**
   * Whether Cloudflare has finished processing the evaluation. Evaluations
   * are asynchronous jobs over logged traffic — this starts `false`.
   */
  processed: boolean;
  /**
   * Number of logs the evaluation covers.
   */
  totalLogs: number;
  /**
   * When the evaluation was created.
   */
  createdAt: string;
  /**
   * When the evaluation was last modified.
   */
  modifiedAt: string;
};

export type Evaluation = Resource<
  TypeId,
  EvaluationProps,
  EvaluationAttributes,
  never,
  Providers
>;

/**
 * An evaluation job on a Cloudflare.AI. Gateway.
 *
 * Evaluations measure performance (speed, cost, feedback) of the logged
 * traffic captured by one or more datasets on a gateway. They are
 * create-only on Cloudflare's side: any prop change replaces the
 * evaluation with a fresh job.
 * @resource
 * @product AI Gateway
 * @category AI
 * @section Creating an Evaluation
 * @example Evaluate a dataset for speed and cost
 * ```typescript
 * const gateway = yield* Cloudflare.AI.Gateway("Gateway");
 *
 * const dataset = yield* Cloudflare.AI.Dataset("SuccessLogs", {
 *   gatewayId: gateway.gatewayId,
 *   filters: [{ key: "success", operator: "eq", value: [true] }],
 * });
 *
 * const types = yield* listEvaluationTypes(gateway.accountId);
 * const evaluation = yield* Cloudflare.AI.Evaluation("Baseline", {
 *   gatewayId: gateway.gatewayId,
 *   datasetIds: [dataset.datasetId],
 *   evaluationTypeIds: types
 *     .filter((t) => t.mandatory)
 *     .map((t) => t.id),
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ai-gateway/evaluations/
 */
export const Evaluation = Resource<Evaluation>(TypeId, {
  aliases: ["Cloudflare.AiGateway.Evaluation"],
});

/**
 * Returns true if the given value is an Evaluation resource.
 */
export const isEvaluation = (value: unknown): value is Evaluation =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

/**
 * List the evaluation types available on the account (speed, cost,
 * feedback, ...). The `mandatory` types must be included in every
 * evaluation.
 */
export const listEvaluationTypes = (accountId: string) =>
  aiGateway
    .listEvaluationTypes({ accountId, perPage: 50 })
    .pipe(Effect.map((page) => page.result));

export const EvaluationProvider = () =>
  Provider.succeed(Evaluation, {
    stables: ["evaluationId", "accountId", "gatewayId", "createdAt"],
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      if (output === undefined) return undefined;
      // Evaluations have no update API — any change is a replacement.
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const newName = news.name ?? output.name;
      if (
        output.gatewayId !== news.gatewayId ||
        output.name !== newName ||
        !deepEqual(output.datasetIds, news.datasetIds) ||
        !deepEqual(output.evaluationTypeIds, news.evaluationTypeIds)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const gatewayId =
        output?.gatewayId ?? (olds?.gatewayId as string | undefined);
      if (gatewayId === undefined) return undefined;
      const knownTypeIds =
        output?.evaluationTypeIds ??
        (olds?.evaluationTypeIds as string[] | undefined) ??
        [];

      if (output?.evaluationId) {
        const observed = yield* getEvaluation(
          acct,
          gatewayId,
          output.evaluationId,
        );
        return observed
          ? toAttributes(observed, acct, knownTypeIds)
          : undefined;
      }
      // Cold read — recover from lost state by matching the deterministic
      // physical name. Names are not unique on Cloudflare's side; an exact
      // match on our generated/explicit name is the best identity we have.
      const name = yield* createEvaluationName(id, olds?.name);
      const match = yield* findByName(acct, gatewayId, name);
      return match ? toAttributes(match, acct, knownTypeIds) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const gatewayId = news.gatewayId as string;
      // Prefer the deployed name: regenerating would target a different
      // resource if the generator's output for this id ever drifts.
      const name = output?.name ?? (yield* createEvaluationName(id, news.name));
      const datasetIds = news.datasetIds as string[];
      const evaluationTypeIds = news.evaluationTypeIds;

      // Observe — the evaluationId cached on `output` is a hint, not a
      // guarantee: a missing evaluation falls through and we recreate.
      const observed = output?.evaluationId
        ? yield* getEvaluation(
            output.accountId ?? accountId,
            gatewayId,
            output.evaluationId,
          )
        : undefined;

      if (observed) {
        // Evaluations are immutable; diff routes every prop change to a
        // replacement, so an observed evaluation is already converged.
        return toAttributes(
          observed,
          accountId,
          output?.evaluationTypeIds ?? evaluationTypeIds,
        );
      }

      // Ensure — greenfield (or out-of-band delete). Cloudflare enforces
      // name uniqueness, so a conflict (e.g. a leftover from an interrupted
      // run or a create race) is converged by adopting the existing
      // evaluation by name instead of failing — evaluations are immutable,
      // and diff routes any prop change to a replacement, so a name match
      // is already the desired evaluation.
      const created = yield* aiGateway
        .createEvaluation({
          accountId,
          gatewayId,
          name,
          datasetIds,
          evaluationTypeIds,
        })
        .pipe(
          Effect.catchTag("EvaluationNameAlreadyExists", (originalError) =>
            findByName(accountId, gatewayId, name).pipe(
              Effect.flatMap((match) =>
                match ? Effect.succeed(match) : Effect.fail(originalError),
              ),
            ),
          ),
        );
      return toAttributes(created, accountId, evaluationTypeIds);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* aiGateway
        .deleteEvaluation({
          accountId: output.accountId,
          gatewayId: output.gatewayId,
          id: output.evaluationId,
        })
        // Cloudflare reports both a missing evaluation and a missing parent
        // gateway with code 7002 — either way it's already gone.
        .pipe(Effect.catchTag("EvaluationNotFound", () => Effect.void));
    }),
    // Evaluations are scoped under an AI Gateway, which itself is
    // account-scoped. Fan out: exhaustively paginate every gateway in the
    // account, then exhaustively paginate the evaluations under each gateway
    // (bounded concurrency) and hydrate each into the same Attributes shape
    // `read` produces (via `toAttributes`). A gateway deleted mid-enumeration
    // returns an empty evaluation list, so no per-item not-found handling is
    // required. We pass `[]` for known type ids: the listed evaluation only
    // echoes type ids back once results exist, and `toAttributes` falls back
    // to the result-derived ids otherwise.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const gatewayIds = yield* aiGateway.listAiGateways
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((gateway) => gateway.id),
            ),
          ),
        );
      const rows = yield* Effect.forEach(
        gatewayIds,
        (gatewayId) =>
          aiGateway.listEvaluations.pages({ accountId, gatewayId }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((evaluation) =>
                  toAttributes(evaluation, accountId, []),
                ),
              ),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
  });

/**
 * Read an evaluation by id, mapping "gone" (`EvaluationNotFound`,
 * Cloudflare error code 7002 — which also covers a deleted parent gateway)
 * to `undefined`.
 */
const getEvaluation = (accountId: string, gatewayId: string, id: string) =>
  aiGateway
    .getEvaluation({ accountId, gatewayId, id })
    .pipe(
      Effect.catchTag("EvaluationNotFound", () => Effect.succeed(undefined)),
    );

/**
 * Find an evaluation by exact name. Cloudflare's `name` query is a fuzzy
 * match, so re-check exactly client-side. If several evaluations carry the
 * same name, pick the oldest for determinism. A missing parent gateway
 * returns an empty list on this endpoint.
 */
const findByName = (accountId: string, gatewayId: string, name: string) =>
  aiGateway.listEvaluations
    .items({ accountId, gatewayId, name, perPage: 50 })
    .pipe(
      Stream.filter((e) => e.name === name),
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .at(0),
      ),
    );

const createEvaluationName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (
  evaluation:
    | aiGateway.GetEvaluationResponse
    | aiGateway.CreateEvaluationResponse
    | aiGateway.ListEvaluationsResponse["result"][number],
  accountId: string,
  knownTypeIds: string[],
): EvaluationAttributes => ({
  evaluationId: evaluation.id,
  accountId,
  gatewayId: evaluation.gatewayId,
  name: evaluation.name,
  datasetIds: evaluation.datasets.map((d) => d.id),
  // The API only echoes evaluation type ids back once results exist, so
  // prefer the observed result types and fall back to what we asked for.
  evaluationTypeIds:
    evaluation.results.length > 0
      ? [...new Set(evaluation.results.map((r) => r.evaluationTypeId))]
      : knownTypeIds,
  processed: evaluation.processed,
  totalLogs: evaluation.totalLogs,
  createdAt: evaluation.createdAt,
  modifiedAt: evaluation.modifiedAt,
});
