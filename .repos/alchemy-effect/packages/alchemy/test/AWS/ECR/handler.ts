import * as ECR from "@/AWS/ECR";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import crypto from "node:crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Deterministic, lowercase repository name scoped to this suite (distinct
// from Repository.test.ts / Image.test.ts repositories).
export const REPO = "alchemy-test-ecr-bindings";

/** Deterministic layer/config bytes per tag so retried pushes converge. */
const layerBytesFor = (tag: string) =>
  Buffer.from(`alchemy ecr layer blob for ${tag}\n`.repeat(8), "utf8");
const configBytesFor = (tag: string) =>
  Buffer.from(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: {},
      rootfs: { type: "layers", diff_ids: [`sha256:${"0".repeat(64)}`] },
      // Distinguish configs per tag so every tag gets its own digest.
      "alchemy.tag": tag,
    }),
    "utf8",
  );

export class EcrTestFunction extends Lambda.Function<Lambda.Function>()(
  "EcrTestFunction",
) {}

export default EcrTestFunction.make(
  {
    main,
    url: true,
    // A push fans out several registry calls; AWS's 3s default would
    // intermittently time out.
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const repository = yield* ECR.Repository("Repo", {
      repositoryName: REPO,
    });

    // Marker store for the event source (events may arrive on another
    // Lambda instance, so they must be observable out-of-band).
    const bucket = yield* S3.Bucket("EventBucket", { forceDestroy: true });
    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);

    // --- registry-scoped binding ---
    const getAuthorizationToken = yield* ECR.GetAuthorizationToken();

    // --- repository-scoped bindings ---
    const describeImages = yield* ECR.DescribeImages(repository);
    const listImages = yield* ECR.ListImages(repository);
    const batchGetImage = yield* ECR.BatchGetImage(repository);
    const getDownloadUrl = yield* ECR.GetDownloadUrlForLayer(repository);
    const checkLayers = yield* ECR.BatchCheckLayerAvailability(repository);
    const initiateUpload = yield* ECR.InitiateLayerUpload(repository);
    const uploadPart = yield* ECR.UploadLayerPart(repository);
    const completeUpload = yield* ECR.CompleteLayerUpload(repository);
    const putImage = yield* ECR.PutImage(repository);
    const batchDeleteImage = yield* ECR.BatchDeleteImage(repository);
    const startImageScan = yield* ECR.StartImageScan(repository);
    const describeScanFindings =
      yield* ECR.DescribeImageScanFindings(repository);

    // --- event source ---
    // ECR publishes every completed push to the default bus; write a marker
    // object per event so /events/probe can observe the delivery
    // out-of-band.
    yield* ECR.consumeImageActions(
      { repositories: [REPO], actionTypes: ["PUSH"], results: ["SUCCESS"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          putObject({
            Key: `events/${event.detail["image-tag"] ?? event.detail["image-digest"]}`,
            Body: JSON.stringify(event.detail),
            ContentType: "application/json",
          }).pipe(Effect.orDie, Effect.asVoid),
        ),
    );

    const sha256 = (bytes: Buffer) =>
      Effect.sync(
        () =>
          `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
      );

    // Upload one blob through the initiate → upload → complete flow.
    // `LayerAlreadyExistsException` means a previous push (or a retried one)
    // already sealed this digest — the blob is present, so continue.
    const uploadBlob = Effect.fn(function* (bytes: Buffer) {
      const digest = yield* sha256(bytes);
      const { uploadId } = yield* initiateUpload();
      yield* uploadPart({
        uploadId: uploadId!,
        partFirstByte: 0,
        partLastByte: bytes.length - 1,
        layerPartBlob: new Uint8Array(bytes),
      });
      yield* completeUpload({
        uploadId: uploadId!,
        layerDigests: [digest],
      }).pipe(
        Effect.catchTag("LayerAlreadyExistsException", () =>
          Effect.succeed(undefined),
        ),
      );
      return digest;
    });

    // Push a minimal-but-valid Docker v2 schema 2 image: a config blob and
    // one layer blob, sealed by a manifest under `tag`.
    const pushImage = Effect.fn(function* (tag: string) {
      const configBytes = configBytesFor(tag);
      const layerBytes = layerBytesFor(tag);
      const configDigest = yield* uploadBlob(configBytes);
      const layerDigest = yield* uploadBlob(layerBytes);
      const manifest = JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.docker.distribution.manifest.v2+json",
        config: {
          mediaType: "application/vnd.docker.container.image.v1+json",
          size: configBytes.length,
          digest: configDigest,
        },
        layers: [
          {
            mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip",
            size: layerBytes.length,
            digest: layerDigest,
          },
        ],
      });
      // A retried push of an identical tag+manifest surfaces the typed
      // ImageAlreadyExistsException — the image is present, so converge.
      const put = yield* putImage({
        imageManifest: manifest,
        imageManifestMediaType:
          "application/vnd.docker.distribution.manifest.v2+json",
        imageTag: tag,
      }).pipe(
        Effect.catchTag("ImageAlreadyExistsException", () =>
          Effect.succeed(undefined),
        ),
      );
      return {
        digest: put?.image?.imageId?.imageDigest,
        layerDigest,
        configDigest,
      };
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const param = (name: string) => url.searchParams.get(name) ?? "";

        // Mint the registry credential; prove it comes back Redacted and
        // decodes to a `AWS:<password>` Docker login pair.
        if (request.method === "GET" && pathname === "/token") {
          const res = yield* getAuthorizationToken();
          const data = res.authorizationData?.[0];
          const token = data?.authorizationToken;
          const raw = Redacted.isRedacted(token)
            ? Redacted.value(token)
            : (token ?? "");
          const decoded = Buffer.from(raw, "base64").toString("utf8");
          return yield* HttpServerResponse.json({
            redacted: Redacted.isRedacted(token),
            length: raw.length,
            decodesToAwsUser: decoded.startsWith("AWS:"),
            proxyEndpoint: data?.proxyEndpoint,
          });
        }

        if (request.method === "POST" && pathname === "/push") {
          const res = yield* pushImage(param("tag"));
          return yield* HttpServerResponse.json(res);
        }

        if (request.method === "GET" && pathname === "/images") {
          const res = yield* describeImages({
            imageIds: [{ imageTag: param("tag") }],
          });
          const detail = res.imageDetails?.[0];
          return yield* HttpServerResponse.json({
            tags: detail?.imageTags,
            digest: detail?.imageDigest,
            sizeInBytes: detail?.imageSizeInBytes,
          });
        }

        if (request.method === "GET" && pathname === "/image-ids") {
          const res = yield* listImages({ filter: { tagStatus: "TAGGED" } });
          return yield* HttpServerResponse.json({
            tags: (res.imageIds ?? []).flatMap((id) =>
              id.imageTag ? [id.imageTag] : [],
            ),
          });
        }

        if (request.method === "GET" && pathname === "/manifest") {
          const res = yield* batchGetImage({
            imageIds: [{ imageTag: param("tag") }],
          });
          const image = res.images?.[0];
          return yield* HttpServerResponse.json({
            mediaType: image?.imageManifestMediaType,
            manifestLength: image?.imageManifest?.length ?? 0,
            failures: res.failures?.map((f) => f.failureCode),
          });
        }

        if (request.method === "GET" && pathname === "/layer") {
          const res = yield* getDownloadUrl({ layerDigest: param("digest") });
          return yield* HttpServerResponse.json({
            hasUrl: (res.downloadUrl ?? "").startsWith("https://"),
            layerDigest: res.layerDigest,
          });
        }

        if (request.method === "GET" && pathname === "/availability") {
          const res = yield* checkLayers({
            layerDigests: [param("digest")],
          });
          return yield* HttpServerResponse.json({
            availability: res.layers?.[0]?.layerAvailability,
            failures: res.failures?.map((f) => f.failureCode),
          });
        }

        // On-demand basic scan. The synthetic image is not a supported OS
        // image, so ECR may answer with the typed
        // UnsupportedImageTypeException (or throttle repeat scans with
        // LimitExceededException) — surface the tag instead of dying.
        if (request.method === "POST" && pathname === "/scan") {
          const res = yield* startImageScan({
            imageId: { imageTag: param("tag") },
          }).pipe(
            Effect.map((r) => ({
              status: r.imageScanStatus?.status,
              error: undefined,
            })),
            Effect.catchTag(
              [
                "UnsupportedImageTypeException",
                "LimitExceededException",
                "ValidationException",
              ],
              (e) => Effect.succeed({ status: undefined, error: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(res);
        }

        // Scan findings for the synthetic image — either real findings or
        // the typed ScanNotFoundException when no scan ever ran.
        if (request.method === "GET" && pathname === "/scan-findings") {
          const res = yield* describeScanFindings({
            imageId: { imageTag: param("tag") },
          }).pipe(
            Effect.map((r) => ({
              status: r.imageScanStatus?.status,
              error: undefined,
            })),
            Effect.catchTag(
              ["ScanNotFoundException", "ValidationException"],
              (e) => Effect.succeed({ status: undefined, error: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(res);
        }

        // batchDeleteImage reports a missing image via `failures` (not an
        // error), so this is naturally idempotent.
        if (request.method === "POST" && pathname === "/delete") {
          const res = yield* batchDeleteImage({
            imageIds: [{ imageTag: param("tag") }],
          });
          return yield* HttpServerResponse.json({
            deleted: (res.imageIds ?? []).length,
            failures: res.failures?.map((f) => f.failureCode),
          });
        }

        // Push a fresh tag, then poll for the marker the image-action event
        // handler wrote to S3 (bounded well under the 60s function timeout).
        if (request.method === "GET" && pathname === "/events/probe") {
          const tag = param("tag");
          yield* pushImage(tag);
          const seen = yield* getObject({ Key: `events/${tag}` }).pipe(
            Effect.retry({
              while: (e): boolean => e._tag === "NoSuchKey",
              schedule: Schedule.spaced("2 seconds"),
              times: 12,
            }),
            Effect.map(() => true),
            Effect.catchTag("NoSuchKey", () => Effect.succeed(false)),
          );
          return yield* HttpServerResponse.json({ seen, tag });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        // Surface typed errors in the 500 body so the test's transient-retry
        // logs show the real failure instead of an opaque Internal Server
        // Error.
        Effect.catch((e) =>
          HttpServerResponse.json(
            {
              error: (e as { _tag?: string })._tag ?? "UnknownError",
              message: String(e),
            },
            { status: 500 },
          ),
        ),
        Effect.orDie,
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        ECR.GetAuthorizationTokenHttp,
        ECR.DescribeImagesHttp,
        ECR.ListImagesHttp,
        ECR.BatchGetImageHttp,
        ECR.GetDownloadUrlForLayerHttp,
        ECR.BatchCheckLayerAvailabilityHttp,
        ECR.InitiateLayerUploadHttp,
        ECR.UploadLayerPartHttp,
        ECR.CompleteLayerUploadHttp,
        ECR.PutImageHttp,
        ECR.BatchDeleteImageHttp,
        ECR.StartImageScanHttp,
        ECR.DescribeImageScanFindingsHttp,
        S3.PutObjectHttp,
        S3.GetObjectHttp,
      ),
    ),
  ),
);
