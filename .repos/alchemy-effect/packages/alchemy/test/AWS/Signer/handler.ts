import { isBindingHost } from "@/AWS/Lambda/Function.ts";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Signer from "@/AWS/Signer";
import * as Binding from "@/Binding";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/**
 * A deterministic one-file zip (`index.js` with a no-op handler) — the code
 * artifact the AWSLambda platform signs. Generated once and checked in.
 */
const CODE_ZIP_BASE64 =
  "UEsDBBQAAAAAAAAAIVyGZ4n3JAAAACQAAAAIAAAAaW5kZXguanNleHBvcnRzLmhhbmRsZXIgPSBhc3luYyAoKSA9PiAoe30pOwpQSwECFAMUAAAAAAAAACFchmeJ9yQAAAAkAAAACAAAAAAAAAAAAAAAgAEAAAAAaW5kZXguanNQSwUGAAAAAAEAAQA2AAAASgAAAAAA";
const CODE_ZIP = Uint8Array.from(Buffer.from(CODE_ZIP_BASE64, "base64"));

/** A syntactically valid Notary payload for `SignPayload`. */
const NOTARY_PAYLOAD = new TextEncoder().encode(
  JSON.stringify({
    targetArtifact: {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest:
        "sha256:73c803930ea3ba1e54bc25c2bdc53edd0284c62ed651fe7b00369da519a3c333",
      size: 1024,
    },
  }),
);

const SOURCE_KEY = "code.zip";

export class SignerTestFunction extends Lambda.Function<Lambda.Function>()(
  "SignerTestFunction",
) {}

export default SignerTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
    // The default 128 MB pins at the ceiling (~123 MB used) once the S3 +
    // Signer clients are warm and 500s under load — give it headroom.
    memorySize: 512,
  },
  Effect.gen(function* () {
    // The profile under test: AWS-managed Lambda code-signing material.
    const profile = yield* Signer.SigningProfile("BindingsProfile", {
      platformId: "AWSLambda-SHA384-ECDSA",
    });
    // A Notation profile for the synchronous SignPayload path.
    const notationProfile = yield* Signer.SigningProfile("NotationProfile", {
      platformId: "Notation-OCI-SHA384-ECDSA",
    });

    // StartSigningJob reads the versioned source object and writes the
    // signed artifact with the CALLER's credentials — bind the S3 access.
    const src = yield* S3.Bucket("SignerSrc", {
      versioning: "Enabled",
      forceDestroy: true,
    });
    const dst = yield* S3.Bucket("SignerDst", { forceDestroy: true });
    // Outputs yield a DEFERRED effect — resolve again per invocation below.
    const SrcName = yield* src.bucketName;
    const DstName = yield* dst.bucketName;

    // Event source: subscribe the host to signing-job status changes. The
    // deploy proves the EventBridge rule + invoke permission wiring.
    yield* Signer.consumeSigningJobEvents({}, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(`signer job ${event.detail.job_id}: ${event.detail.status}`),
      ),
    );

    const putObject = yield* S3.PutObject(src);
    yield* S3.GetObject(src); // grants s3:GetObject(Version) for the signing job
    yield* S3.PutObject(dst); // grants s3:PutObject on the destination

    // Signer validates BUCKET-level access on both buckets when starting a
    // job ("S3 bucket … not accessible") — grant the documented signing-
    // caller set the object-level bindings above don't cover.
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      if (isBindingHost(host)) {
        yield* host.bind`Allow(${host}, SignerSourceDestinationBucketAccess)`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "s3:GetBucketLocation",
                "s3:GetBucketVersioning",
                "s3:ListBucket",
                "s3:ListBucketVersions",
              ],
              Resource: [src.bucketArn, dst.bucketArn],
            },
          ],
        });
      }
    }

    const startSigningJob = yield* Signer.StartSigningJob(profile);
    const signPayload = yield* Signer.SignPayload(notationProfile);
    const revokeSigningProfile =
      yield* Signer.RevokeSigningProfile(notationProfile);
    const describeSigningJob = yield* Signer.DescribeSigningJob();
    const listSigningJobs = yield* Signer.ListSigningJobs();
    const revokeSignature = yield* Signer.RevokeSignature();
    const getRevocationStatus = yield* Signer.GetRevocationStatus();
    const getSigningPlatform = yield* Signer.GetSigningPlatform();
    const listSigningPlatforms = yield* Signer.ListSigningPlatforms();

    const bound = {
      startSigningJob,
      signPayload,
      revokeSigningProfile,
      describeSigningJob,
      listSigningJobs,
      revokeSignature,
      getRevocationStatus,
      getSigningPlatform,
      listSigningPlatforms,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const id = url.searchParams.get("id");

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/platforms") {
          // The catalog paginates with a small page size — walk it (bounded).
          const ids: (string | undefined)[] = [];
          let nextToken: string | undefined;
          let pages = 0;
          do {
            const page = yield* listSigningPlatforms({
              maxResults: 25,
              nextToken,
            });
            ids.push(...(page.platforms ?? []).map((p) => p.platformId));
            nextToken = page.nextToken;
            pages += 1;
          } while (nextToken !== undefined && pages < 10);
          return yield* HttpServerResponse.json({ ids });
        }

        if (request.method === "GET" && pathname === "/platform") {
          const platform = yield* getSigningPlatform({
            platformId: id ?? "AWSLambda-SHA384-ECDSA",
          });
          return yield* HttpServerResponse.json({
            platformId: platform.platformId,
            revocationSupported: platform.revocationSupported ?? false,
          });
        }

        // Upload the code zip (capturing the object version) and start a
        // signing job over it — the profileName is injected by the binding.
        if (request.method === "POST" && pathname === "/start") {
          const uploaded = yield* putObject({
            Key: SOURCE_KEY,
            Body: CODE_ZIP,
            ContentType: "application/zip",
          });
          if (uploaded.VersionId === undefined) {
            // Bucket versioning still propagating — the test re-polls.
            return yield* HttpServerResponse.json({
              ok: false,
              tag: "NoVersionId",
            });
          }
          const started = yield* startSigningJob({
            // Required idempotency token — a fresh UUID per request so each
            // POST /start begins a new signing job.
            clientRequestToken: yield* Effect.sync(() => crypto.randomUUID()),
            source: {
              s3: {
                bucketName: yield* SrcName,
                key: SOURCE_KEY,
                version: uploaded.VersionId!,
              },
            },
            destination: {
              s3: { bucketName: yield* DstName, prefix: "signed/" },
            },
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json(
            started._tag === "Success"
              ? { ok: true, jobId: started.success.jobId }
              : {
                  ok: false,
                  tag: started.failure._tag,
                  message: started.failure.message,
                },
          );
        }

        if (request.method === "GET" && pathname === "/jobs") {
          const { jobs } = yield* listSigningJobs({ maxResults: 25 });
          return yield* HttpServerResponse.json({
            jobIds: (jobs ?? []).map((j) => j.jobId),
          });
        }

        // Synchronous Notation signing — reports the typed rejection tag if
        // Signer refuses the payload so the test can assert the round-trip.
        if (request.method === "POST" && pathname === "/sign") {
          const signed = yield* signPayload({
            payload: NOTARY_PAYLOAD,
            payloadFormat: "application/vnd.cncf.notary.payload.v1+json",
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json(
            signed._tag === "Success"
              ? {
                  ok: true,
                  jobId: signed.success.jobId,
                  hasSignature: (signed.success.signature?.length ?? 0) > 0,
                }
              : { ok: false, tag: signed.failure._tag },
          );
        }

        if (id === null) {
          return yield* HttpServerResponse.json(
            { error: "missing id" },
            { status: 400 },
          );
        }

        if (request.method === "GET" && pathname === "/job") {
          // A freshly-started job can 404 for a few seconds (eventual
          // consistency) — report the typed tag so the test keeps polling.
          const job = yield* describeSigningJob({ jobId: id }).pipe(
            Effect.result,
          );
          return yield* HttpServerResponse.json(
            job._tag === "Success"
              ? {
                  status: job.success.status,
                  signedKey: job.success.signedObject?.s3?.key,
                }
              : { status: "Pending", tag: job.failure._tag },
          );
        }

        if (request.method === "POST" && pathname === "/revoke-job") {
          const revoked = yield* revokeSignature({
            jobId: id,
            reason: "alchemy-test",
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json(
            revoked._tag === "Success"
              ? { revoked: true }
              : { revoked: false, tag: revoked.failure._tag },
          );
        }

        // Revocation-status check for a completed job. ARNs are derived from
        // the job's own metadata; empty certificateHashes may be rejected
        // with a typed ValidationException — the route reports the tag so
        // the test can assert the binding round-trips with IAM intact.
        if (request.method === "GET" && pathname === "/revocation") {
          const job = yield* describeSigningJob({ jobId: id });
          const region = yield* Effect.sync(() => process.env.AWS_REGION);
          const arnBase = `arn:aws:signer:${region}:${job.jobOwner}`;
          const checked = yield* getRevocationStatus({
            signatureTimestamp: job.completedAt ?? new Date(),
            platformId: job.platformId!,
            profileVersionArn: `${arnBase}:/signing-profiles/${job.profileName}/${job.profileVersion}`,
            jobArn: `${arnBase}:/signing-jobs/${job.jobId}`,
            certificateHashes: [],
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json(
            checked._tag === "Success"
              ? {
                  ok: true,
                  revokedEntities: checked.success.revokedEntities ?? [],
                }
              : { ok: false, tag: checked.failure._tag },
          );
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
        Lambda.EventSource,
        S3.PutObjectHttp,
        S3.GetObjectHttp,
        Signer.StartSigningJobHttp,
        Signer.SignPayloadHttp,
        Signer.RevokeSigningProfileHttp,
        Signer.DescribeSigningJobHttp,
        Signer.ListSigningJobsHttp,
        Signer.RevokeSignatureHttp,
        Signer.GetRevocationStatusHttp,
        Signer.GetSigningPlatformHttp,
        Signer.ListSigningPlatformsHttp,
      ),
    ),
  ),
);
