import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const GATEWAY_ID = "alchemy-test-aigw-eval";

class EvaluationStillExists extends Data.TaggedError("EvaluationStillExists") {}

// A deleted evaluation surfaces as `EvaluationNotFound` (Cloudflare error
// code 7002, which also covers a deleted parent gateway) — that's the
// success condition here.
const expectGone = (
  accountId: string,
  gatewayId: string,
  evaluationId: string,
) =>
  aiGateway.getEvaluation({ accountId, gatewayId, id: evaluationId }).pipe(
    Effect.flatMap(() => Effect.fail(new EvaluationStillExists())),
    Effect.retry({
      while: (e): e is EvaluationStillExists =>
        e instanceof EvaluationStillExists,
      schedule: Schedule.max([
        Schedule.exponential("250 millis"),
        Schedule.recurs(10),
      ]),
    }),
    Effect.catchTag("EvaluationNotFound", () => Effect.void),
  );

test.provider("create, noop, replace, delete an evaluation", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    // The mandatory evaluation types (speed, cost) are account-global
    // constants — discover their ids out-of-band.
    const types = yield* Cloudflare.AI.listEvaluationTypes(accountId);
    const typeIds = types
      .filter((t) => t.mandatory)
      .map((t) => t.id)
      .sort();
    expect(typeIds.length).toBeGreaterThan(0);

    const program = (name: string) =>
      Effect.gen(function* () {
        const gateway = yield* Cloudflare.AI.Gateway("EvalGateway", {
          id: GATEWAY_ID,
        });
        const dataset = yield* Cloudflare.AI.Dataset("EvalDataset", {
          gatewayId: gateway.gatewayId,
          name: "alchemy-test-eval-dataset",
          filters: [{ key: "success", operator: "eq", value: [true] }],
        });
        const evaluation = yield* Cloudflare.AI.Evaluation("Evaluation", {
          gatewayId: gateway.gatewayId,
          name,
          datasetIds: [dataset.datasetId],
          evaluationTypeIds: typeIds,
        });
        return { dataset, evaluation };
      });

    const initial = yield* stack.deploy(program("alchemy-test-eval"));

    expect(initial.evaluation.evaluationId).toBeDefined();
    expect(initial.evaluation.accountId).toEqual(accountId);
    expect(initial.evaluation.gatewayId).toEqual(GATEWAY_ID);
    expect(initial.evaluation.name).toEqual("alchemy-test-eval");
    expect(initial.evaluation.datasetIds).toEqual([initial.dataset.datasetId]);
    expect([...initial.evaluation.evaluationTypeIds].sort()).toEqual(typeIds);
    expect(initial.evaluation.totalLogs).toEqual(0);

    // Verify out-of-band via the API.
    const live = yield* aiGateway.getEvaluation({
      accountId,
      gatewayId: GATEWAY_ID,
      id: initial.evaluation.evaluationId,
    });
    expect(live.name).toEqual("alchemy-test-eval");
    expect(live.datasets.map((d) => d.id)).toEqual([initial.dataset.datasetId]);

    // Redeploying identical props is a no-op (still the same evaluation).
    const noop = yield* stack.deploy(program("alchemy-test-eval"));
    expect(noop.evaluation.evaluationId).toEqual(
      initial.evaluation.evaluationId,
    );

    // Evaluations are create-only — renaming is a replacement.
    const renamed = yield* stack.deploy(program("alchemy-test-eval-v2"));
    expect(renamed.evaluation.name).toEqual("alchemy-test-eval-v2");
    expect(renamed.evaluation.evaluationId).not.toEqual(
      initial.evaluation.evaluationId,
    );

    // The replaced evaluation is gone.
    yield* expectGone(accountId, GATEWAY_ID, initial.evaluation.evaluationId);

    yield* stack.destroy();

    yield* expectGone(accountId, GATEWAY_ID, renamed.evaluation.evaluationId);
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed evaluation", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const types = yield* Cloudflare.AI.listEvaluationTypes(accountId);
    const typeIds = types
      .filter((t) => t.mandatory)
      .map((t) => t.id)
      .sort();
    expect(typeIds.length).toBeGreaterThan(0);

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const gateway = yield* Cloudflare.AI.Gateway("EvalGateway", {
          id: GATEWAY_ID,
        });
        const dataset = yield* Cloudflare.AI.Dataset("EvalDataset", {
          gatewayId: gateway.gatewayId,
          name: "alchemy-test-eval-list-dataset",
          filters: [{ key: "success", operator: "eq", value: [true] }],
        });
        const evaluation = yield* Cloudflare.AI.Evaluation("Evaluation", {
          gatewayId: gateway.gatewayId,
          name: "alchemy-test-eval-list",
          datasetIds: [dataset.datasetId],
          evaluationTypeIds: typeIds,
        });
        return { evaluation };
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.AI.Evaluation);
    const all = yield* provider.list();

    const found = all.find(
      (e) => e.evaluationId === deployed.evaluation.evaluationId,
    );
    expect(found).toBeDefined();
    expect(found?.accountId).toEqual(accountId);
    expect(found?.gatewayId).toEqual(GATEWAY_ID);
    expect(found?.name).toEqual("alchemy-test-eval-list");

    yield* stack.destroy();
  }).pipe(logLevel),
);
