import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { zipFiles } from "@/Util/zip.ts";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as S3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";

const layerV1Path = fileURLToPath(
  new URL("./fixtures/layer-v1", import.meta.url),
);
const layerV2Path = fileURLToPath(
  new URL("./fixtures/layer-v2", import.meta.url),
);
const timeoutHandlerPath = fileURLToPath(
  new URL("./timeout-handler.ts", import.meta.url),
);

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "publish, republish, attach to a function, list, delete layer version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = ({
        path,
        description,
        withFunction = false,
        layered = true,
      }: {
        path: string;
        description?: string;
        withFunction?: boolean;
        layered?: boolean;
      }) =>
        Effect.gen(function* () {
          const layer = yield* AWS.Lambda.LayerVersion("Deps", {
            path,
            description,
            compatibleRuntimes: ["nodejs22.x"],
          });

          const fn = withFunction
            ? yield* AWS.Lambda.Function("LayeredFn", {
                main: timeoutHandlerPath,
                handler: "handler",
                isExternal: true,
                functionUrl: false,
                // Pass the resource itself — `layers` also accepts a raw ARN.
                layers: layered ? [layer] : [],
              })
            : undefined;

          return { layer, fn };
        });

      // --- create ---
      const created = yield* stack.deploy(program({ path: layerV1Path }));
      const v1 = created.layer;

      expect(v1.version).toBeGreaterThan(0);
      expect(v1.layerVersionArn).toBe(`${v1.layerArn}:${v1.version}`);
      expect(v1.compatibleRuntimes).toEqual(["nodejs22.x"]);

      const cloudV1 = yield* getLayerVersionOrUndefined(
        v1.layerName,
        v1.version,
      );
      expect(cloudV1).toBeDefined();
      expect(cloudV1!.LayerVersionArn).toBe(v1.layerVersionArn);
      expect(cloudV1!.Content?.CodeSha256).toBe(v1.codeSha256);

      // --- noop (identical content must not publish a new version) ---
      const unchanged = yield* stack.deploy(program({ path: layerV1Path }));
      expect(unchanged.layer.version).toBe(v1.version);
      expect(unchanged.layer.layerVersionArn).toBe(v1.layerVersionArn);

      // --- update (changed content publishes a new version of the SAME
      // layer, rather than stranding a fresh layer at version 1) ---
      const republished = yield* stack.deploy(program({ path: layerV2Path }));
      const v2 = republished.layer;

      expect(v2.layerName).toBe(v1.layerName);
      expect(v2.layerArn).toBe(v1.layerArn);
      expect(v2.version).toBe(v1.version + 1);
      expect(v2.layerVersionArn).not.toBe(v1.layerVersionArn);
      expect(v2.codeSha256).not.toBe(v1.codeSha256);

      // The superseded version is retired, so updates don't leak one
      // version per deploy.
      expect(
        yield* getLayerVersionOrUndefined(v1.layerName, v1.version),
      ).toBeUndefined();

      // --- update (changed description alone also republishes) ---
      const described = yield* stack.deploy(
        program({ path: layerV2Path, description: "with description" }),
      );
      expect(described.layer.layerName).toBe(v1.layerName);
      expect(described.layer.version).toBe(v2.version + 1);
      expect(described.layer.description).toBe("with description");

      const currentLayer = described.layer;

      // --- attach to a function ---
      const attached = yield* stack.deploy(
        program({
          path: layerV2Path,
          description: "with description",
          withFunction: true,
        }),
      );
      const functionName = attached.fn!.functionName;

      expect(
        (yield* getFunctionLayers(functionName)).map((layer) => layer.Arn),
      ).toEqual([currentLayer.layerVersionArn]);

      // --- detach ---
      yield* stack.deploy(
        program({
          path: layerV2Path,
          description: "with description",
          withFunction: true,
          layered: false,
        }),
      );
      expect(yield* getFunctionLayers(functionName)).toEqual([]);

      // --- list ---
      const provider = yield* Provider.findProvider(AWS.Lambda.LayerVersion);
      const versions = yield* provider.list();
      expect(
        versions.some(
          (version) => version.layerVersionArn === currentLayer.layerVersionArn,
        ),
      ).toBe(true);

      // --- delete ---
      yield* stack.destroy();

      expect(
        yield* getLayerVersionOrUndefined(
          currentLayer.layerName,
          currentLayer.version,
        ),
      ).toBeUndefined();
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 360_000 },
);

// Both `layers` and `s3.bucket` accept either the resource itself or the raw
// identifier. Switching a deployed stack between the two forms must converge
// on the same cloud state rather than churning the layer version.
test.provider(
  "layers and s3.bucket accept a resource or a raw identifier, and cycle between them",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const archive = yield* zipFiles([
        { path: "nodejs/from-s3.mjs", content: "export const via = 's3';\n" },
      ]);

      // --- s3.bucket: resource form ---
      const s3Program = (byName: boolean) =>
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("LayerSource", {
            forceDestroy: true,
          });
          const layer = yield* AWS.Lambda.LayerVersion("FromS3", {
            s3: {
              bucket: byName ? bucket.bucketName : bucket,
              key: LAYER_KEY,
            },
          });
          return { bucket, layer };
        });

      // The object has to exist before the layer publishes, so create the
      // bucket on its own first.
      const bucketOnly = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.S3.Bucket("LayerSource", { forceDestroy: true });
        }),
      );
      yield* S3.putObject({
        Bucket: bucketOnly.bucketName,
        Key: LAYER_KEY,
        Body: new Uint8Array(archive),
      });

      const byResource = yield* stack.deploy(s3Program(false));
      expect(byResource.layer.version).toBe(1);
      expect(byResource.layer.layerVersionArn).toContain(":1");

      // --- s3.bucket: cycle to the raw-name form ---
      const byName = yield* stack.deploy(s3Program(true));
      // Same bucket, expressed differently — must NOT republish.
      expect(byName.layer.layerVersionArn).toBe(
        byResource.layer.layerVersionArn,
      );
      expect(byName.layer.version).toBe(byResource.layer.version);

      // --- and back again ---
      const backToResource = yield* stack.deploy(s3Program(false));
      expect(backToResource.layer.layerVersionArn).toBe(
        byResource.layer.layerVersionArn,
      );

      // --- layers: both forms, cycled ---
      const fnProgram = (byArn: boolean) =>
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("LayerSource", {
            forceDestroy: true,
          });
          const layer = yield* AWS.Lambda.LayerVersion("FromS3", {
            s3: { bucket, key: LAYER_KEY },
          });
          const fn = yield* AWS.Lambda.Function("RefFormFn", {
            main: timeoutHandlerPath,
            handler: "handler",
            isExternal: true,
            functionUrl: false,
            layers: [byArn ? layer.layerVersionArn : layer],
          });
          return { bucket, layer, fn };
        });

      const withResource = yield* stack.deploy(fnProgram(false));
      const layerArn = backToResource.layer.layerVersionArn;
      expect(
        (yield* getFunctionLayers(withResource.fn.functionName)).map(
          (l) => l.Arn,
        ),
      ).toEqual([layerArn]);

      const withArn = yield* stack.deploy(fnProgram(true));
      // Cycling the reference form is a no-op, not a phantom update: same
      // function, same attached layer, no re-issued configuration call.
      expect(withArn.fn.functionName).toBe(withResource.fn.functionName);
      expect(
        (yield* getFunctionLayers(withArn.fn.functionName)).map((l) => l.Arn),
      ).toEqual([layerArn]);

      // ...and back to the resource form.
      const backToRef = yield* stack.deploy(fnProgram(false));
      expect(
        (yield* getFunctionLayers(backToRef.fn.functionName)).map((l) => l.Arn),
      ).toEqual([layerArn]);

      yield* stack.destroy();
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 360_000 },
);

const LAYER_KEY = "layers/from-s3.zip";

const getLayerVersionOrUndefined = Effect.fn(function* (
  layerName: string,
  version: number,
) {
  return yield* Lambda.getLayerVersion({
    LayerName: layerName,
    VersionNumber: version,
  }).pipe(
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );
});

const getFunctionLayers = Effect.fn(function* (functionName: string) {
  const configuration = yield* Lambda.getFunctionConfiguration({
    FunctionName: functionName,
  });
  return configuration.Layers ?? [];
});
