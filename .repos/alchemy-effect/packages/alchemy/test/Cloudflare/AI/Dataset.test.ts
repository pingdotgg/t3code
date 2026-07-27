import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const GATEWAY_ID = "alchemy-test-aigw-dataset";
const GATEWAY_ID_B = "alchemy-test-aigw-dataset-b";

class DatasetStillExists extends Data.TaggedError("DatasetStillExists") {}

// A deleted dataset surfaces as `DatasetNotFound` (Cloudflare error code
// 7002, which also covers a deleted parent gateway) — that's the success
// condition here.
const expectGone = (accountId: string, gatewayId: string, datasetId: string) =>
  aiGateway.getDataset({ accountId, gatewayId, id: datasetId }).pipe(
    Effect.flatMap(() => Effect.fail(new DatasetStillExists())),
    Effect.retry({
      while: (e): e is DatasetStillExists => e instanceof DatasetStillExists,
      schedule: Schedule.max([
        Schedule.exponential("250 millis"),
        Schedule.recurs(10),
      ]),
    }),
    Effect.catchTag("DatasetNotFound", () => Effect.void),
  );

// Every case provisions a gateway under the same fixed `GATEWAY_ID`, so under
// the suite's default concurrent execution one case's `stack.destroy()` would
// delete the gateway out from under another (yielding "Gateway ... not
// found"). Run them one at a time so each owns its gateway lifecycle.
describe.sequential("AiGatewayDataset", () => {
  test.provider("create, update, delete a dataset on a gateway", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* Cloudflare.AI.Gateway("DatasetGateway", {
            id: GATEWAY_ID,
          });
          const dataset = yield* Cloudflare.AI.Dataset("Dataset", {
            gatewayId: gateway.gatewayId,
            name: "alchemy-test-dataset",
            filters: [{ key: "success", operator: "eq", value: [true] }],
          });
          return { gateway, dataset };
        }),
      );

      expect(initial.dataset.datasetId).toBeDefined();
      expect(initial.dataset.accountId).toEqual(accountId);
      expect(initial.dataset.gatewayId).toEqual(GATEWAY_ID);
      expect(initial.dataset.name).toEqual("alchemy-test-dataset");
      expect(initial.dataset.enable).toBe(true);
      expect(initial.dataset.filters).toEqual([
        { key: "success", operator: "eq", value: [true] },
      ]);

      // Verify out-of-band via the API.
      const live = yield* aiGateway.getDataset({
        accountId,
        gatewayId: GATEWAY_ID,
        id: initial.dataset.datasetId,
      });
      expect(live.name).toEqual("alchemy-test-dataset");
      expect(live.enable).toBe(true);
      expect(live.filters).toEqual([
        { key: "success", operator: "eq", value: [true] },
      ]);

      // Update mutable props in place — same dataset id.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* Cloudflare.AI.Gateway("DatasetGateway", {
            id: GATEWAY_ID,
          });
          const dataset = yield* Cloudflare.AI.Dataset("Dataset", {
            gatewayId: gateway.gatewayId,
            name: "alchemy-test-dataset-v2",
            enable: false,
            filters: [
              { key: "provider", operator: "eq", value: ["workers-ai"] },
              { key: "cached", operator: "eq", value: [false] },
            ],
          });
          return { gateway, dataset };
        }),
      );

      expect(updated.dataset.datasetId).toEqual(initial.dataset.datasetId);
      expect(updated.dataset.name).toEqual("alchemy-test-dataset-v2");
      expect(updated.dataset.enable).toBe(false);
      expect(updated.dataset.filters).toHaveLength(2);

      const liveUpdated = yield* aiGateway.getDataset({
        accountId,
        gatewayId: GATEWAY_ID,
        id: initial.dataset.datasetId,
      });
      expect(liveUpdated.name).toEqual("alchemy-test-dataset-v2");
      expect(liveUpdated.enable).toBe(false);
      expect(liveUpdated.filters).toHaveLength(2);

      // Redeploying identical props is a no-op (still the same dataset).
      const noop = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* Cloudflare.AI.Gateway("DatasetGateway", {
            id: GATEWAY_ID,
          });
          const dataset = yield* Cloudflare.AI.Dataset("Dataset", {
            gatewayId: gateway.gatewayId,
            name: "alchemy-test-dataset-v2",
            enable: false,
            filters: [
              { key: "provider", operator: "eq", value: ["workers-ai"] },
              { key: "cached", operator: "eq", value: [false] },
            ],
          });
          return { gateway, dataset };
        }),
      );
      expect(noop.dataset.datasetId).toEqual(initial.dataset.datasetId);

      yield* stack.destroy();

      yield* expectGone(accountId, GATEWAY_ID, initial.dataset.datasetId);
    }).pipe(logLevel),
  );

  test.provider("replaces dataset when the gateway changes", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const gatewayA = yield* Cloudflare.AI.Gateway("ReplaceGatewayA", {
            id: GATEWAY_ID,
          });
          yield* Cloudflare.AI.Gateway("ReplaceGatewayB", {
            id: GATEWAY_ID_B,
          });
          const dataset = yield* Cloudflare.AI.Dataset("ReplaceDataset", {
            gatewayId: gatewayA.gatewayId,
            name: "alchemy-test-dataset-replace",
            filters: [],
          });
          return { dataset };
        }),
      );
      expect(initial.dataset.gatewayId).toEqual(GATEWAY_ID);

      // Moving the dataset to another gateway is a replacement: new id,
      // new parent, and the old dataset is removed from gateway A.
      const moved = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Cloudflare.AI.Gateway("ReplaceGatewayA", {
            id: GATEWAY_ID,
          });
          const gatewayB = yield* Cloudflare.AI.Gateway("ReplaceGatewayB", {
            id: GATEWAY_ID_B,
          });
          const dataset = yield* Cloudflare.AI.Dataset("ReplaceDataset", {
            gatewayId: gatewayB.gatewayId,
            name: "alchemy-test-dataset-replace",
            filters: [],
          });
          return { dataset };
        }),
      );

      expect(moved.dataset.gatewayId).toEqual(GATEWAY_ID_B);
      expect(moved.dataset.datasetId).not.toEqual(initial.dataset.datasetId);

      // The replaced dataset is gone from gateway A.
      yield* expectGone(accountId, GATEWAY_ID, initial.dataset.datasetId);

      yield* stack.destroy();

      yield* expectGone(accountId, GATEWAY_ID_B, moved.dataset.datasetId);
    }).pipe(logLevel),
  );

  test.provider("recreates a dataset after out-of-band delete", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* Cloudflare.AI.Gateway("HealGateway", {
            id: GATEWAY_ID,
          });
          const dataset = yield* Cloudflare.AI.Dataset("HealDataset", {
            gatewayId: gateway.gatewayId,
            name: "alchemy-test-dataset-heal",
            filters: [{ key: "success", operator: "eq", value: [true] }],
          });
          return { dataset };
        }),
      );

      // Delete the dataset out-of-band. A redeploy with identical props is a
      // planner no-op, so change a prop to force reconcile — it must observe
      // the dataset as missing and recreate it instead of failing on a 404.
      yield* aiGateway.deleteDataset({
        accountId,
        gatewayId: GATEWAY_ID,
        id: initial.dataset.datasetId,
      });

      const healed = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* Cloudflare.AI.Gateway("HealGateway", {
            id: GATEWAY_ID,
          });
          const dataset = yield* Cloudflare.AI.Dataset("HealDataset", {
            gatewayId: gateway.gatewayId,
            name: "alchemy-test-dataset-heal",
            enable: false,
            filters: [{ key: "success", operator: "eq", value: [true] }],
          });
          return { dataset };
        }),
      );

      expect(healed.dataset.datasetId).not.toEqual(initial.dataset.datasetId);
      expect(healed.dataset.enable).toBe(false);

      const live = yield* aiGateway.getDataset({
        accountId,
        gatewayId: GATEWAY_ID,
        id: healed.dataset.datasetId,
      });
      expect(live.name).toEqual("alchemy-test-dataset-heal");

      yield* stack.destroy();

      yield* expectGone(accountId, GATEWAY_ID, healed.dataset.datasetId);
    }).pipe(logLevel),
  );

  test.provider("list enumerates datasets across gateways", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* Cloudflare.AI.Gateway("ListGateway", {
            id: GATEWAY_ID,
          });
          const dataset = yield* Cloudflare.AI.Dataset("ListDataset", {
            gatewayId: gateway.gatewayId,
            name: "alchemy-test-dataset-list",
            filters: [{ key: "success", operator: "eq", value: [true] }],
          });
          return { dataset };
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.AI.Dataset);
      const all = yield* provider.list();

      expect(all.some((d) => d.datasetId === deployed.dataset.datasetId)).toBe(
        true,
      );

      yield* stack.destroy();

      yield* expectGone(accountId, GATEWAY_ID, deployed.dataset.datasetId);
    }).pipe(logLevel),
  );
});
