import * as ECRPublic from "@/AWS/ECRPublic";
import * as Lambda from "@/AWS/Lambda";
import crypto from "node:crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// A well-formed-but-nonexistent layer digest — batchCheckLayerAvailability
// reports it as a per-layer failure, proving the repository-scoped grant.
const NONEXISTENT_DIGEST = `sha256:${"0".repeat(64)}`;

const sha256Hex = (bytes: Uint8Array) =>
  Effect.sync(() => crypto.createHash("sha256").update(bytes).digest("hex"));

export class EcrPublicTestFunction extends Lambda.Function<Lambda.Function>()(
  "EcrPublicTestFunction",
) {}

export default EcrPublicTestFunction.make(
  {
    main,
    url: true,
    // The push-flow route performs several sequential ECR Public calls; the
    // AWS default 3s Lambda timeout is too tight.
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const repository = yield* ECRPublic.PublicRepository("BindingsRepo", {
      catalogData: {
        description: "alchemy ECRPublic bindings fixture",
        architectures: ["x86-64"],
        operatingSystems: ["Linux"],
      },
    });

    // --- repository-scoped bindings ---
    const describeImages = yield* ECRPublic.DescribeImages(repository);
    const describeImageTags = yield* ECRPublic.DescribeImageTags(repository);
    const getRepositoryCatalogData =
      yield* ECRPublic.GetRepositoryCatalogData(repository);
    const batchCheckLayerAvailability =
      yield* ECRPublic.BatchCheckLayerAvailability(repository);
    const batchDeleteImage = yield* ECRPublic.BatchDeleteImage(repository);
    const initiateLayerUpload =
      yield* ECRPublic.InitiateLayerUpload(repository);
    const uploadLayerPart = yield* ECRPublic.UploadLayerPart(repository);
    const completeLayerUpload =
      yield* ECRPublic.CompleteLayerUpload(repository);
    const putImage = yield* ECRPublic.PutImage(repository);

    // --- registry-level bindings ---
    const getAuthorizationToken = yield* ECRPublic.GetAuthorizationToken();
    const describeRegistries = yield* ECRPublic.DescribeRegistries();
    const getRegistryCatalogData = yield* ECRPublic.GetRegistryCatalogData();

    const bound = {
      describeImages,
      describeImageTags,
      getRepositoryCatalogData,
      batchCheckLayerAvailability,
      batchDeleteImage,
      initiateLayerUpload,
      uploadLayerPart,
      completeLayerUpload,
      putImage,
      getAuthorizationToken,
      describeRegistries,
      getRegistryCatalogData,
    };

    /**
     * Upload one blob as a layer: initiate → upload the single (last) part →
     * complete with the blob's sha256. A re-run finds the layer already
     * sealed — `LayerAlreadyExistsException` converges to the same digest.
     */
    const uploadBlob = Effect.fn(function* (blob: Uint8Array) {
      const digest = `sha256:${yield* sha256Hex(blob)}`;
      const { uploadId } = yield* initiateLayerUpload();
      yield* uploadLayerPart({
        uploadId: uploadId!,
        partFirstByte: 0,
        partLastByte: blob.byteLength - 1,
        layerPartBlob: blob,
      });
      yield* completeLayerUpload({
        uploadId: uploadId!,
        layerDigests: [digest],
      }).pipe(
        Effect.catchTag("LayerAlreadyExistsException", () => Effect.void),
      );
      return digest;
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/registries") {
          const result = yield* describeRegistries();
          const registry = result.registries?.[0];
          return yield* HttpServerResponse.json({
            count: (result.registries ?? []).length,
            alias: registry?.aliases?.[0]?.name ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/registry-catalog") {
          const result = yield* getRegistryCatalogData();
          return yield* HttpServerResponse.json({
            tag: "Ok",
            displayName: result.registryCatalogData.displayName ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/auth-token") {
          const result = yield* getAuthorizationToken();
          const token = result.authorizationData?.authorizationToken;
          // The token is Redacted in the distilled response — never echo it.
          const hasToken =
            token !== undefined &&
            (typeof token === "string"
              ? token.length > 0
              : Redacted.value(token).length > 0);
          return yield* HttpServerResponse.json({ hasToken });
        }

        if (request.method === "GET" && pathname === "/repo-catalog") {
          const result = yield* getRepositoryCatalogData();
          return yield* HttpServerResponse.json({
            description: result.catalogData?.description ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/images") {
          const result = yield* describeImages();
          return yield* HttpServerResponse.json({
            count: (result.imageDetails ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/image-tags") {
          const result = yield* describeImageTags();
          return yield* HttpServerResponse.json({
            count: (result.imageTagDetails ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/check-layers") {
          const result = yield* batchCheckLayerAvailability({
            layerDigests: [NONEXISTENT_DIGEST],
          });
          // ECR Public reports a nonexistent digest either as a per-layer
          // failure or as a layer with `layerAvailability: "UNAVAILABLE"`.
          return yield* HttpServerResponse.json({
            failures: (result.failures ?? []).length,
            unavailable: (result.layers ?? []).filter(
              (l) => l.layerAvailability !== "AVAILABLE",
            ).length,
          });
        }

        if (request.method === "GET" && pathname === "/delete-missing") {
          const result = yield* batchDeleteImage({
            imageIds: [{ imageTag: "does-not-exist" }],
          });
          return yield* HttpServerResponse.json({
            failureCode: result.failures?.[0]?.failureCode ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/push-flow") {
          // A genuine (minimal) image push: upload a config blob and a layer
          // blob, then put a docker v2 manifest referencing both. Re-runs
          // converge — existing layers and an identical manifest are fine.
          const layerBlob = new TextEncoder().encode(
            "alchemy-ecr-public-bindings-fixture-layer",
          );
          const configBlob = new TextEncoder().encode(
            JSON.stringify({
              architecture: "amd64",
              os: "linux",
              config: {},
              rootfs: { type: "layers", diff_ids: [NONEXISTENT_DIGEST] },
            }),
          );
          const layerDigest = yield* uploadBlob(layerBlob);
          const configDigest = yield* uploadBlob(configBlob);
          const imageManifest = JSON.stringify({
            schemaVersion: 2,
            mediaType: "application/vnd.docker.distribution.manifest.v2+json",
            config: {
              mediaType: "application/vnd.docker.container.image.v1+json",
              size: configBlob.byteLength,
              digest: configDigest,
            },
            layers: [
              {
                mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip",
                size: layerBlob.byteLength,
                digest: layerDigest,
              },
            ],
          });
          const result = yield* putImage({
            imageManifest,
            imageManifestMediaType:
              "application/vnd.docker.distribution.manifest.v2+json",
            imageTag: "bindings-test",
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok",
              imageDigest: r.image?.imageId?.imageDigest ?? null,
            })),
            // Re-running the route pushes the identical manifest+tag again.
            Effect.catchTag(
              ["ImageAlreadyExistsException", "ImageTagAlreadyExistsException"],
              (e) => Effect.succeed({ tag: e._tag, imageDigest: null }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ECRPublic.DescribeImagesHttp,
        ECRPublic.DescribeImageTagsHttp,
        ECRPublic.GetRepositoryCatalogDataHttp,
        ECRPublic.BatchCheckLayerAvailabilityHttp,
        ECRPublic.BatchDeleteImageHttp,
        ECRPublic.InitiateLayerUploadHttp,
        ECRPublic.UploadLayerPartHttp,
        ECRPublic.CompleteLayerUploadHttp,
        ECRPublic.PutImageHttp,
        ECRPublic.GetAuthorizationTokenHttp,
        ECRPublic.DescribeRegistriesHttp,
        ECRPublic.GetRegistryCatalogDataHttp,
      ),
    ),
  ),
);
