import * as AWS from "@/AWS";
import { Asset, AssetModel, Gateway } from "@/AWS/IoTSiteWise";
import * as Test from "@/Test/Alchemy";
import * as sitewise from "@distilled.cloud/aws/iotsitewise";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete/wait paths depend on. Runs in
// every CI pass at near-zero cost.
test.provider(
  "describeAssetModel on a nonexistent id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        sitewise.describeAssetModel({
          // syntactically valid UUID that does not exist
          assetModelId: "12345678-1234-4123-8123-123456789012",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Bounded wait until a describe reports the resource gone.
const untilGone = <R>(
  label: string,
  probe: Effect.Effect<"gone" | string, never, R>,
) =>
  Effect.gen(function* () {
    const state = yield* probe;
    if (state !== "gone") {
      return yield* Effect.fail(
        new Error(`${label} still exists (state: ${state})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "asset model + asset lifecycle (create, update, destroy)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (description: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const model = yield* AssetModel("PumpModel", {
              assetModelDescription: description,
              assetModelProperties: [
                {
                  name: "SerialNumber",
                  dataType: "STRING",
                  type: { attribute: { defaultValue: "unknown" } },
                },
                {
                  name: "Temperature",
                  dataType: "DOUBLE",
                  unit: "Celsius",
                  type: { measurement: {} },
                },
              ],
              tags: { fixture: "iotsitewise" },
            });
            const asset = yield* Asset("Pump1", {
              assetModelId: model.assetModelId,
              assetDescription: description,
              tags: { fixture: "iotsitewise" },
            });
            return { model, asset };
          }),
        );

      // Create.
      const first = yield* deploy("pump model v1");
      expect(first.model.assetModelId).toBeDefined();
      expect(first.model.assetModelArn).toContain(":asset-model/");
      expect(first.model.state).toBe("ACTIVE");
      expect(first.asset.assetArn).toContain(":asset/");
      expect(first.asset.state).toBe("ACTIVE");
      expect(first.asset.assetModelId).toBe(first.model.assetModelId);

      // Out-of-band verification via distilled.
      const describedModel = yield* sitewise.describeAssetModel({
        assetModelId: first.model.assetModelId,
      });
      expect(describedModel.assetModelDescription).toBe("pump model v1");
      expect(
        describedModel.assetModelProperties.map((p) => p.name).sort(),
      ).toEqual(["SerialNumber", "Temperature"]);
      const describedAsset = yield* sitewise.describeAsset({
        assetId: first.asset.assetId,
        excludeProperties: true,
      });
      expect(describedAsset.assetDescription).toBe("pump model v1");
      const modelTags = yield* sitewise.listTagsForResource({
        resourceArn: first.model.assetModelArn,
      });
      expect(modelTags.tags?.fixture).toBe("iotsitewise");
      expect(modelTags.tags?.["alchemy::id"]).toBe("PumpModel");

      // Update in place — descriptions change, ids are stable.
      const second = yield* deploy("pump model v2");
      expect(second.model.assetModelId).toBe(first.model.assetModelId);
      expect(second.asset.assetId).toBe(first.asset.assetId);
      const updatedModel = yield* sitewise.describeAssetModel({
        assetModelId: first.model.assetModelId,
        excludeProperties: true,
      });
      expect(updatedModel.assetModelDescription).toBe("pump model v2");
      const updatedAsset = yield* sitewise.describeAsset({
        assetId: first.asset.assetId,
        excludeProperties: true,
      });
      expect(updatedAsset.assetDescription).toBe("pump model v2");

      // Destroy — asset must go before the model; verify both are gone.
      yield* stack.destroy();
      yield* untilGone(
        "asset",
        sitewise
          .describeAsset({
            assetId: first.asset.assetId,
            excludeProperties: true,
          })
          .pipe(
            Effect.map((r) => r.assetStatus.state as string),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed("gone" as const),
            ),
            Effect.orDie,
          ),
      );
      yield* untilGone(
        "asset model",
        sitewise
          .describeAssetModel({
            assetModelId: first.model.assetModelId,
            excludeProperties: true,
          })
          .pipe(
            Effect.map((r) => r.assetModelStatus.state as string),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed("gone" as const),
            ),
            Effect.orDie,
          ),
      );
    }),
  { timeout: 240_000 },
);

test.provider(
  "gateway lifecycle with platform replacement",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (coreDeviceThingName: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const gateway = yield* Gateway("EdgeGateway", {
              gatewayPlatform: { greengrassV2: { coreDeviceThingName } },
              tags: { fixture: "iotsitewise-gateway" },
            });
            return { gateway };
          }),
        );

      // Create — the referenced core device does not need to exist.
      const first = yield* deploy("AlchemyIoTSiteWiseCoreA");
      expect(first.gateway.gatewayId).toBeDefined();
      expect(first.gateway.gatewayArn).toContain(":gateway/");

      // Out-of-band verification via distilled.
      const described = yield* sitewise.describeGateway({
        gatewayId: first.gateway.gatewayId,
      });
      expect(described.gatewayPlatform?.greengrassV2?.coreDeviceThingName).toBe(
        "AlchemyIoTSiteWiseCoreA",
      );
      const tags = yield* sitewise.listTagsForResource({
        resourceArn: first.gateway.gatewayArn,
      });
      expect(tags.tags?.fixture).toBe("iotsitewise-gateway");

      // Changing the platform replaces the gateway.
      const second = yield* deploy("AlchemyIoTSiteWiseCoreB");
      expect(second.gateway.gatewayId).not.toBe(first.gateway.gatewayId);
      expect(
        (yield* sitewise.describeGateway({
          gatewayId: second.gateway.gatewayId,
        })).gatewayPlatform?.greengrassV2?.coreDeviceThingName,
      ).toBe("AlchemyIoTSiteWiseCoreB");
      yield* untilGone(
        "replaced gateway",
        sitewise.describeGateway({ gatewayId: first.gateway.gatewayId }).pipe(
          Effect.map(() => "exists"),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed("gone" as const),
          ),
          Effect.orDie,
        ),
      );

      // Destroy and verify gone.
      yield* stack.destroy();
      yield* untilGone(
        "gateway",
        sitewise.describeGateway({ gatewayId: second.gateway.gatewayId }).pipe(
          Effect.map(() => "exists"),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed("gone" as const),
          ),
          Effect.orDie,
        ),
      );
    }),
  { timeout: 180_000 },
);
