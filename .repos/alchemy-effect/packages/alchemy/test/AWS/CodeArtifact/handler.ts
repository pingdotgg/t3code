import * as CodeArtifact from "@/AWS/CodeArtifact";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import crypto from "node:crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Deterministic, lowercase CodeArtifact identifiers scoped to this suite
// (distinct from Repository.test.ts's `alchemy-test-ca` domain).
export const DOMAIN = "alchemy-test-ca-bind";
export const REPO = "alchemy-test-ca-bind-repo";
export const MIRROR = "alchemy-test-ca-bind-mirror";
const FORMAT = "generic" as const;
const NAMESPACE = "alchemy";
const PKG = "test-package";
const ASSET = "artifact.txt";

const contentFor = (version: string) => `hello codeartifact ${version}`;

export class CodeArtifactTestFunction extends Lambda.Function<Lambda.Function>()(
  "CodeArtifactTestFunction",
) {}

export default CodeArtifactTestFunction.make(
  {
    main,
    url: true,
    // The publish → copy → dispose flows fan out several SDK calls; AWS's
    // 3s default would intermittently time out.
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const domain = yield* CodeArtifact.Domain("Domain", {
      domainName: DOMAIN,
    });
    const repo = yield* CodeArtifact.Repository("Repo", {
      domain: domain.domainName,
      repositoryName: REPO,
    });
    const mirror = yield* CodeArtifact.Repository("Mirror", {
      domain: domain.domainName,
      repositoryName: MIRROR,
    });

    // Marker store for the event source (events may arrive on another
    // Lambda instance, so they must be observable out-of-band).
    const bucket = yield* S3.Bucket("EventBucket", { forceDestroy: true });
    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);

    // --- domain-scoped binding ---
    const getToken = yield* CodeArtifact.GetAuthorizationToken(domain);

    // --- repository-scoped bindings ---
    const getEndpoint = yield* CodeArtifact.GetRepositoryEndpoint(repo);
    const listPackages = yield* CodeArtifact.ListPackages(repo);
    const describePackage = yield* CodeArtifact.DescribePackage(repo);
    const describeVersion = yield* CodeArtifact.DescribePackageVersion(repo);
    const listVersions = yield* CodeArtifact.ListPackageVersions(repo);
    const listAssets = yield* CodeArtifact.ListPackageVersionAssets(repo);
    const listDeps = yield* CodeArtifact.ListPackageVersionDependencies(repo);
    const getReadme = yield* CodeArtifact.GetPackageVersionReadme(repo);
    const getAsset = yield* CodeArtifact.GetPackageVersionAsset(repo);
    const publish = yield* CodeArtifact.PublishPackageVersion(repo);
    const updateStatus = yield* CodeArtifact.UpdatePackageVersionsStatus(repo);
    const putOrigin = yield* CodeArtifact.PutPackageOriginConfiguration(repo);
    const deletePackage = yield* CodeArtifact.DeletePackage(repo);

    // --- mirror-scoped bindings (destination of the copy) ---
    const copyToMirror = yield* CodeArtifact.CopyPackageVersions(mirror);
    const listMirrorPackages = yield* CodeArtifact.ListPackages(mirror);
    const disposeMirror = yield* CodeArtifact.DisposePackageVersions(mirror);
    const deleteMirrorVersions =
      yield* CodeArtifact.DeletePackageVersions(mirror);
    const deleteMirrorPackage = yield* CodeArtifact.DeletePackage(mirror);

    // --- event source ---
    // CodeArtifact publishes every package version change to the default
    // bus; write a marker object per event so /events/probe can observe the
    // delivery out-of-band.
    yield* CodeArtifact.consumePackageVersionStateChanges(
      { repositories: [REPO, MIRROR] },
      (events) =>
        Stream.runForEach(events, (event) =>
          putObject({
            Key: `events/${event.detail.packageVersion}`,
            Body: JSON.stringify(event.detail),
            ContentType: "application/json",
          }).pipe(Effect.orDie, Effect.asVoid),
        ),
    );

    const publishVersion = Effect.fn(function* (
      version: string,
      unfinished: boolean,
    ) {
      const content = contentFor(version);
      const sha = yield* Effect.sync(() =>
        crypto.createHash("sha256").update(content).digest("hex"),
      );
      return yield* publish({
        format: FORMAT,
        namespace: NAMESPACE,
        package: PKG,
        packageVersion: version,
        assetName: ASSET,
        assetContent: content,
        assetSHA256: sha,
        ...(unfinished ? { unfinished: true } : {}),
      });
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const param = (name: string) => url.searchParams.get(name) ?? "";

        // Mint a domain authorization token; prove it comes back Redacted.
        if (request.method === "GET" && pathname === "/token") {
          const res = yield* getToken({ duration: "15 minutes" });
          const token = res.authorizationToken;
          return yield* HttpServerResponse.json({
            redacted: Redacted.isRedacted(token),
            length: (Redacted.isRedacted(token)
              ? Redacted.value(token)
              : (token ?? "")
            ).length,
          });
        }

        if (request.method === "GET" && pathname === "/endpoint") {
          const res = yield* getEndpoint({ format: FORMAT });
          return yield* HttpServerResponse.json({
            endpoint: res.repositoryEndpoint,
          });
        }

        // Delete the test package from both repositories so a retried test
        // body starts from a clean slate — republishing an already-Published
        // generic version raises the (deterministic) ConflictException.
        if (request.method === "POST" && pathname === "/reset") {
          yield* deletePackage({
            format: FORMAT,
            namespace: NAMESPACE,
            package: PKG,
          }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          yield* deleteMirrorPackage({
            format: FORMAT,
            namespace: NAMESPACE,
            package: PKG,
          }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          return yield* HttpServerResponse.json({ reset: true });
        }

        if (request.method === "POST" && pathname === "/publish") {
          const res = yield* publishVersion(
            param("version"),
            param("unfinished") === "1",
          );
          return yield* HttpServerResponse.json({ status: res.status });
        }

        if (request.method === "GET" && pathname === "/package") {
          const res = yield* describePackage({
            format: FORMAT,
            namespace: NAMESPACE,
            package: PKG,
          });
          return yield* HttpServerResponse.json({
            name: res.package?.name,
            format: res.package?.format,
            namespace: res.package?.namespace,
          });
        }

        if (request.method === "GET" && pathname === "/version") {
          const res = yield* describeVersion({
            format: FORMAT,
            namespace: NAMESPACE,
            package: PKG,
            packageVersion: param("version"),
          });
          return yield* HttpServerResponse.json({
            version: res.packageVersion?.version,
            status: res.packageVersion?.status,
          });
        }

        if (request.method === "GET" && pathname === "/packages") {
          const res = yield* listPackages({});
          return yield* HttpServerResponse.json({
            names: (res.packages ?? []).map((p) => p.package),
          });
        }

        if (request.method === "GET" && pathname === "/versions") {
          const res = yield* listVersions({
            format: FORMAT,
            namespace: NAMESPACE,
            package: PKG,
          });
          return yield* HttpServerResponse.json({
            versions: (res.versions ?? []).map((v) => v.version),
          });
        }

        if (request.method === "GET" && pathname === "/assets") {
          const res = yield* listAssets({
            format: FORMAT,
            namespace: NAMESPACE,
            package: PKG,
            packageVersion: param("version"),
          });
          return yield* HttpServerResponse.json({
            assets: (res.assets ?? []).map((a) => a.name),
          });
        }

        if (request.method === "GET" && pathname === "/asset") {
          const res = yield* getAsset({
            format: FORMAT,
            namespace: NAMESPACE,
            package: PKG,
            packageVersion: param("version"),
            asset: ASSET,
          });
          const content = yield* Stream.mkString(
            Stream.decodeText(res.asset!),
          ).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ content });
        }

        // Generic packages have no readme — CodeArtifact answers with the
        // typed ResourceNotFoundException ("The readme file of this package
        // version is not found"); surface the tag instead of dying.
        if (request.method === "GET" && pathname === "/readme") {
          const res = yield* getReadme({
            format: FORMAT,
            namespace: NAMESPACE,
            package: PKG,
            packageVersion: param("version"),
          }).pipe(
            Effect.map((r) => ({ readme: r.readme ?? "", error: undefined })),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed({ readme: undefined, error: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(res);
        }

        // Generic packages record no dependency manifest — surfaces the
        // typed not-found/validation error instead of dying.
        if (request.method === "GET" && pathname === "/deps") {
          const res = yield* listDeps({
            format: FORMAT,
            namespace: NAMESPACE,
            package: PKG,
            packageVersion: param("version"),
          }).pipe(
            Effect.map((r) => ({
              dependencies: (r.dependencies ?? []).map((d) => d.package),
              error: undefined,
            })),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed({ dependencies: undefined, error: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(res);
        }

        if (request.method === "POST" && pathname === "/status") {
          const res = yield* updateStatus({
            format: FORMAT,
            namespace: NAMESPACE,
            package: PKG,
            versions: [param("version")],
            targetStatus: param("target"),
          });
          return yield* HttpServerResponse.json({
            successful: Object.keys(res.successfulVersions ?? {}),
          });
        }

        if (request.method === "POST" && pathname === "/origin") {
          const res = yield* putOrigin({
            format: FORMAT,
            namespace: NAMESPACE,
            package: PKG,
            restrictions: { publish: "ALLOW", upstream: "BLOCK" },
          });
          return yield* HttpServerResponse.json({
            restrictions: res.originConfiguration?.restrictions,
          });
        }

        if (request.method === "POST" && pathname === "/copy") {
          const res = yield* copyToMirror({
            sourceRepository: REPO,
            format: FORMAT,
            namespace: NAMESPACE,
            package: PKG,
            versions: [param("version")],
          });
          return yield* HttpServerResponse.json({
            successful: Object.keys(res.successfulVersions ?? {}),
          });
        }

        if (request.method === "GET" && pathname === "/mirror/packages") {
          const res = yield* listMirrorPackages({});
          return yield* HttpServerResponse.json({
            names: (res.packages ?? []).map((p) => p.package),
          });
        }

        if (request.method === "POST" && pathname === "/mirror/dispose") {
          const res = yield* disposeMirror({
            format: FORMAT,
            namespace: NAMESPACE,
            package: PKG,
            versions: [param("version")],
          });
          return yield* HttpServerResponse.json({
            successful: Object.keys(res.successfulVersions ?? {}),
          });
        }

        if (
          request.method === "POST" &&
          pathname === "/mirror/delete-versions"
        ) {
          const res = yield* deleteMirrorVersions({
            format: FORMAT,
            namespace: NAMESPACE,
            package: PKG,
            versions: [param("version")],
          });
          return yield* HttpServerResponse.json({
            successful: Object.keys(res.successfulVersions ?? {}),
          });
        }

        if (
          request.method === "POST" &&
          pathname === "/mirror/delete-package"
        ) {
          yield* deleteMirrorPackage({
            format: FORMAT,
            namespace: NAMESPACE,
            package: PKG,
          }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          return yield* HttpServerResponse.json({ deleted: true });
        }

        // Publish a fresh version, then poll for the event-source marker the
        // state-change handler wrote to S3 (bounded well under the 60s
        // function timeout).
        if (request.method === "GET" && pathname === "/events/probe") {
          const version = param("version");
          // A retried probe re-publishes the same version — CodeArtifact
          // rejects updates to a Published generic version with the typed
          // ConflictException; the event already fired, so just poll.
          yield* publishVersion(version, false).pipe(
            Effect.catchTag("ConflictException", () =>
              Effect.succeed(undefined),
            ),
          );
          const seen = yield* getObject({ Key: `events/${version}` }).pipe(
            Effect.retry({
              while: (e): boolean => e._tag === "NoSuchKey",
              schedule: Schedule.spaced("2 seconds"),
              times: 12,
            }),
            Effect.map(() => true),
            Effect.catchTag("NoSuchKey", () => Effect.succeed(false)),
          );
          return yield* HttpServerResponse.json({ seen, version });
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
        CodeArtifact.GetAuthorizationTokenHttp,
        CodeArtifact.GetRepositoryEndpointHttp,
        CodeArtifact.ListPackagesHttp,
        CodeArtifact.DescribePackageHttp,
        CodeArtifact.DescribePackageVersionHttp,
        CodeArtifact.ListPackageVersionsHttp,
        CodeArtifact.ListPackageVersionAssetsHttp,
        CodeArtifact.ListPackageVersionDependenciesHttp,
        CodeArtifact.GetPackageVersionReadmeHttp,
        CodeArtifact.GetPackageVersionAssetHttp,
        CodeArtifact.PublishPackageVersionHttp,
        CodeArtifact.UpdatePackageVersionsStatusHttp,
        CodeArtifact.PutPackageOriginConfigurationHttp,
        CodeArtifact.CopyPackageVersionsHttp,
        CodeArtifact.DisposePackageVersionsHttp,
        CodeArtifact.DeletePackageVersionsHttp,
        CodeArtifact.DeletePackageHttp,
        S3.PutObjectHttp,
        S3.GetObjectHttp,
      ),
    ),
  ),
);
