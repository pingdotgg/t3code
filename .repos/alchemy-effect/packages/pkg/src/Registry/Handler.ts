import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import { sha256 } from "alchemy/Util/sha256";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { ManifestJson, type ManifestPackage } from "../Manifest.ts";
import {
  BadRequest,
  Forbidden,
  manifestArtifactName,
  MissingTarballs,
  PackageTooLarge,
  PkgApi,
  RunNotInProgress,
  RunRef,
  Upstream,
} from "../Protocol.ts";
import {
  Bucket,
  Cache,
  COMMENT_MARKER,
  Database,
  RegistryConfig,
  tarballKey,
} from "./Bindings.ts";
import * as GitHub from "./GitHub.ts";
import * as KVCache from "./KVCache.ts";
import { sweep } from "./Sweep.ts";
import * as Tags from "./Tags.ts";

/** What GitHub says about a run. */
const Run = Schema.Struct({
  ...RunRef.fields,
  headSha: Schema.String,
  headBranch: Schema.NullOr(Schema.String),
  headRepo: Schema.String,
  pr: Schema.NullOr(Schema.Number),
});
type Run = typeof Run.Type;

const bindings = Layer.mergeAll(
  Cloudflare.R2.ReadWriteBucketBinding,
  Cloudflare.D1.QueryDatabaseBinding,
  Cloudflare.KV.ReadWriteNamespaceBinding,
  Cloudflare.Workers.CronEventSourceLive,
  FetchHttpClient.layer,
);

const SHORT = 7;

/** How long a resolved run is reused for uploads before asking GitHub again. */
const RUN_CACHE = Duration.minutes(1);

const CHECK_NAME = "Preview packages";

/** The public origin a request arrived on. */
const origin = Effect.map(
  HttpServerRequest,
  (request) => `https://${request.headers.host ?? "localhost"}`,
);

/**
 * A run from a fork: its head commit belongs to another repository, so its
 * workflow file, and therefore everything it packs, is the fork's.
 */
const isFork = (run: Run) => run.headRepo !== run.repo;

/**
 * Tags every package in a publication receives, all derived from the run.
 * Runs on the repository's own commits get the head commit, the short
 * commit, `branch:<name>`, and `pr:N` for pull requests. A fork's run gets
 * only `pr:N`: commit tags are shared by every publisher, and a fork can
 * run any commit it likes, including one already published from the
 * repository, so letting it write them would let it repoint them.
 */
export const tagsFor = (run: Run): string[] => {
  if (isFork(run)) {
    return run.pr === null ? [] : [`pr:${run.pr}`];
  }
  const tags = [run.headSha, run.headSha.slice(0, SHORT)];
  if (run.pr !== null) tags.push(`pr:${run.pr}`);
  if (run.headBranch) tags.push(`branch:${run.headBranch}`);
  return tags;
};

/** The tag install commands are written against. */
export const installTag = (run: Run) =>
  isFork(run) ? `pr:${run.pr}` : run.headSha.slice(0, SHORT);

const upstream = (e: { readonly _tag: string; readonly message?: string }) =>
  new Upstream({ message: GitHub.describe(e) });

/**
 * Storage failures are not part of the protocol: they are defects, which
 * the router answers with a 500 after logging the cause.
 */
const storageFailures = ["R2Error", "SqlError", "SchemaError"] as const;

/**
 * Resolve the run a request names through GitHub; nothing about it is
 * trusted from the client. Only allowed repositories are looked up at all,
 * and the run must be in progress, since requests come from inside it.
 */
const lookupRun = Effect.fn("lookupRun")(function* (ref: RunRef) {
  const { policy } = yield* RegistryConfig;
  const github = yield* GitHub.GitHubApp;

  if (!policy.repos.includes(ref.repo)) {
    return yield* new Forbidden({ message: `${ref.repo} may not publish` });
  }
  const data = yield* github
    .getRun(ref.repo, ref.runId)
    .pipe(Effect.mapError(upstream));
  if (
    data.status !== "in_progress" ||
    (data.run_attempt !== undefined && data.run_attempt !== ref.attempt)
  ) {
    return yield* new RunNotInProgress({ message: "run is not in progress" });
  }
  if (data.event !== "push" && data.event !== "pull_request") {
    return yield* new BadRequest({
      message: `unsupported event ${data.event}`,
    });
  }
  const headRepo = data.head_repository?.full_name ?? data.repository.full_name;
  let pr: number | null = null;
  if (data.event === "pull_request") {
    // The pull request whose head is this run's head, from the repository
    // the run's head lives in. The same commit can head several pull
    // requests, including one opened from a fork against a commit the
    // repository already published; matching the head repository keeps a
    // run's publication on its own pull request.
    const pulls = yield* github
      .pullRequestsForCommit(ref.repo, headRepo, data.head_sha)
      .pipe(Effect.mapError(upstream));
    const first = pulls[0];
    if (first === undefined) {
      return yield* new BadRequest({
        message: `no pull request from ${headRepo} has head ${data.head_sha}`,
      });
    }
    pr = first.number;
  } else if (headRepo !== ref.repo) {
    return yield* new BadRequest({
      message: `push run ${ref.runId} is for ${headRepo}, not ${ref.repo}`,
    });
  }
  return {
    ...ref,
    headSha: data.head_sha,
    headBranch: data.head_branch,
    headRepo,
    pr,
  } satisfies Run;
});

/**
 * The proof. The job uploaded the manifest as an artifact of its run,
 * named by the manifest's hash. Only the job can add artifacts to the
 * run, and GitHub reports the run's artifacts to the App, so a matching
 * name means this run vouched for exactly this manifest text.
 */
const requireVouched = Effect.fn("requireVouched")(function* (
  run: Run,
  manifestText: string,
) {
  const github = yield* GitHub.GitHubApp;
  const expected = manifestArtifactName(yield* sha256(manifestText));
  const artifacts = yield* github
    .listRunArtifacts(run.repo, run.runId, expected)
    .pipe(Effect.mapError(upstream));
  if (!artifacts.some((a) => a.name === expected && !a.expired)) {
    return yield* new Forbidden({
      message: `run ${run.runId} has not vouched for this manifest (no artifact ${expected})`,
    });
  }
});

const publish = Effect.fn("publish")(function* (
  run: Run,
  manifestText: string,
) {
  const { policy } = yield* RegistryConfig;
  const r2 = yield* Cloudflare.R2.ReadWriteBucket(Bucket);
  const github = yield* GitHub.GitHubApp;
  const base = yield* origin;

  yield* requireVouched(run, manifestText);
  const manifest = yield* Schema.decodeUnknownEffect(ManifestJson)(
    manifestText,
  ).pipe(
    Effect.mapError(
      (e) => new BadRequest({ message: `invalid manifest: ${String(e)}` }),
    ),
  );
  // The run vouched for the manifest, but the tags come from the run's
  // head, so the packed checkout has to be that commit: a `pull_request`
  // job that packs the synthetic merge commit would otherwise publish bytes
  // built from a commit that exists nowhere under the commit's name.
  if (manifest.head !== run.headSha) {
    return yield* new BadRequest({
      message: `manifest was packed at ${manifest.head}, but the run's head is ${run.headSha}`,
    });
  }
  const packages = manifest.packages;
  const maxSize = policy.maxPackageSize;
  const tooLarge =
    maxSize === undefined
      ? undefined
      : packages.find((pkg) => BigInt(pkg.size) > maxSize);
  if (tooLarge !== undefined) {
    return yield* new PackageTooLarge({
      message: `${tooLarge.name} exceeds ${maxSize} bytes`,
    });
  }

  const missing = yield* Effect.filter(
    packages,
    (pkg) =>
      r2
        .head(tarballKey(pkg.name, pkg.sha256))
        .pipe(Effect.map((object) => object === null)),
    { concurrency: 8 },
  ).pipe(
    Effect.map((packages) =>
      packages.map(({ name, sha256 }) => ({ name, sha256 })),
    ),
  );
  if (missing.length > 0) {
    return yield* new MissingTarballs({ missing });
  }

  const now = yield* Clock.currentTimeMillis;
  const expiresAt = now + Duration.toMillis(policy.ttl);
  const prs = run.pr !== null ? [`${run.repo}#${run.pr}`] : [];
  const tags = tagsFor(run);
  const tag = installTag(run);
  const published = yield* Effect.forEach(
    packages,
    Effect.fn(function* (pkg: ManifestPackage) {
      yield* Effect.forEach(
        tags,
        (tag) =>
          Tags.upsert({
            package: pkg.name,
            tag,
            sha256: pkg.sha256,
            expiresAt,
            prs,
          }),
        { discard: true },
      );
      return {
        name: pkg.name,
        group: pkg.group,
        url: `${base}/${pkg.name}/${tag}`,
        tags,
      };
    }),
    { concurrency: 4 },
  );

  // A check on the commit itself, so the install lines are visible on
  // pushes and on fork pull requests alike.
  yield* github
    .createCheckRun(run.repo, {
      headSha: run.headSha,
      name: CHECK_NAME,
      title: `${packages.length} package(s) published`,
      summary: GitHub.renderInstalls(published, manifest.groups),
      detailsUrl: base,
    })
    .pipe(
      Effect.catch((e) =>
        Effect.logWarning(
          `check run on ${run.repo}@${run.headSha} failed: ${GitHub.describe(e)}`,
        ),
      ),
    );
  if (run.pr !== null) {
    const body = GitHub.renderComment(published, manifest.groups, {
      publishedAt: now,
      expiresAt,
    });
    yield* github
      .upsertComment(run.repo, run.pr, COMMENT_MARKER, body)
      .pipe(
        Effect.catch((e) =>
          Effect.logWarning(
            `comment on ${run.repo}#${run.pr} failed: ${GitHub.describe(e)}`,
          ),
        ),
      );
  }
  return { packages: published };
});

/**
 * Content-addressed upload, streamed straight into R2 with the hash
 * verified by R2 itself. Untagged objects are swept after a day.
 */
const uploadTarball = Effect.fn("uploadTarball")(function* (
  request: HttpServerRequest,
  name: string,
  sha256: string,
) {
  const { policy } = yield* RegistryConfig;
  const r2 = yield* Cloudflare.R2.ReadWriteBucket(Bucket);

  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    return yield* new BadRequest({ message: "Content-Length is required" });
  }
  const maxSize = policy.maxPackageSize;
  if (maxSize !== undefined && BigInt(contentLength) > maxSize) {
    return yield* new PackageTooLarge({
      message: `tarball exceeds ${maxSize} bytes`,
    });
  }
  const key = tarballKey(name, sha256);
  const existing = yield* r2.head(key);
  if (existing !== null) {
    return { name, sha256, size: existing.size, uploaded: false };
  }
  yield* r2
    .put(key, request.stream, {
      contentLength,
      // The params schema already constrained this to 64 hex chars.
      sha256: Result.getOrThrow(Encoding.decodeHex(sha256)),
    })
    .pipe(
      Effect.mapError(
        (e) => new BadRequest({ message: `upload rejected: ${String(e)}` }),
      ),
    );
  return { name, sha256, size: contentLength, uploaded: true };
});

/**
 * Parse `/<name>/<tag>` and `/<name>/-/<sha256>.tgz`. Scoped names take
 * two segments; the tag is everything after the name and may itself contain
 * `/` and `:`.
 */
export const parseInstallPath = (
  pathname: string,
  scope: string | undefined,
):
  | { kind: "tag"; name: string; tag: string }
  | { kind: "tarball"; name: string; sha256: string }
  | undefined => {
  let path: string;
  try {
    path = decodeURIComponent(pathname.replace(/^\/+/, ""));
  } catch {
    // Malformed percent-encoding is a path nothing can be published under.
    return undefined;
  }
  const tarball = path.match(
    /^(@[^/]+\/[^/@]+|[^/@]+)\/-\/([a-f0-9]{64})\.tgz$/,
  );
  if (tarball) {
    return {
      kind: "tarball",
      name: qualify(tarball[1]!, scope),
      sha256: tarball[2]!,
    };
  }
  const segments = path.split("/");
  const nameLength = path.startsWith("@") ? 2 : 1;
  const name = segments.slice(0, nameLength).join("/");
  const tag = segments.slice(nameLength).join("/");
  if (segments.length <= nameLength || name === "" || tag === "") {
    return undefined;
  }
  return { kind: "tag", name: qualify(name, scope), tag };
};

const qualify = (name: string, scope: string | undefined) =>
  scope !== undefined && !name.startsWith("@") ? `${scope}/${name}` : name;

const notFound = (message: string) =>
  HttpServerResponse.json({ error: message }, { status: 404 });

/**
 * Install URLs: `/<name>/<tag>` redirects to the immutable tarball URL,
 * `/<name>/-/<sha256>.tgz` streams it from R2. Everything the API routes
 * do not claim lands here.
 */
const install = Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  const { aliases } = yield* RegistryConfig;
  const r2 = yield* Cloudflare.R2.ReadWriteBucket(Bucket);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return yield* HttpServerResponse.json(
      { error: "method not allowed" },
      { status: 405 },
    );
  }
  const host = request.headers.host ?? "localhost";
  const target = parseInstallPath(
    new URL(request.url, `https://${host}`).pathname,
    aliases[host],
  );
  if (target === undefined) {
    return yield* notFound("not found");
  }
  if (target.kind === "tag") {
    const sha256 = yield* Tags.resolve(target.name, target.tag);
    if (sha256 === undefined) {
      return yield* notFound(`${target.name}@${target.tag} not found`);
    }
    return HttpServerResponse.redirect(`/${target.name}/-/${sha256}.tgz`, {
      status: 302,
      headers: { "cache-control": "no-store" },
    });
  }
  const object = yield* r2.get(tarballKey(target.name, target.sha256));
  if (object === null) {
    return yield* notFound("tarball not found");
  }
  const headers = {
    "content-type": "application/gzip",
    "content-length": String(object.size),
    "cache-control": "public, max-age=31536000, immutable",
  };
  return request.method === "HEAD"
    ? HttpServerResponse.empty({ status: 200, headers })
    : HttpServerResponse.stream(object.body, { status: 200, headers });
});

const banner = Effect.map(origin, (base) =>
  HttpServerResponse.text(
    `Preview package registry. Install with: bun add ${base}/<package>/<commit|branch:name|pr:N>\n`,
  ),
);

/**
 * The registry never serves files, so the HTTP platform's file surface is
 * stubbed rather than pulling a file system into the Worker.
 */
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("fileResponse is not supported"),
  fileWebResponse: () => Effect.die("fileWebResponse is not supported"),
});

/**
 * The registry Worker's Init phase. Runs at plan time to register bindings
 * and the cron trigger, and once per isolate at runtime to build the
 * router. Everything it needs comes from {@link RegistryConfig}.
 */
export const handler = Effect.gen(function* () {
  const config = yield* RegistryConfig;
  // Binding the capabilities here is what registers the R2, D1, and KV
  // bindings on the Worker at plan time. Handlers bind them again per event,
  // which at runtime is just a lookup in the Worker's environment.
  yield* Cloudflare.R2.ReadWriteBucket(Bucket);
  yield* Cloudflare.KV.ReadWriteNamespace(Cache);
  const d1 = yield* Cloudflare.D1.QueryDatabase(Database);

  // Built once per isolate. The D1 client memoizes its connection on each
  // event's scope, so its layer is safe to share.
  const github = yield* GitHub.GitHubApp.pipe(
    Effect.provide(GitHub.GitHubAppLive),
  );
  const services = Layer.mergeAll(
    Cloudflare.R2.ReadWriteBucketBinding,
    Cloudflare.KV.ReadWriteNamespaceBinding,
    SQL.D1Layer(d1),
    Layer.succeed(GitHub.GitHubApp, github),
    Layer.succeed(RegistryConfig, config),
  );

  // Recently resolved runs are reused so the uploads that follow a publish
  // do not repeat the lookup. Failures are not kept.
  const runs = KVCache.make(
    (ref: RunRef) => `run:${ref.repo}#${ref.runId}:${ref.attempt}`,
    Run,
    (ref) => Effect.map(lookupRun(ref), (value) => ({ value, ttl: RUN_CACHE })),
  );

  yield* Cloudflare.Workers.cron(config.cron, () =>
    sweep.pipe(Effect.provide(services)),
  );

  const registry = HttpApiBuilder.group(PkgApi, "Registry", (handlers) =>
    handlers
      .handle("publish", ({ payload }) =>
        Effect.flatMap(runs(payload.run), (run) =>
          publish(run, payload.manifest),
        ).pipe(Effect.catchTag(storageFailures, (e) => Effect.die(e))),
      )
      // Raw so the body streams into R2 instead of being buffered.
      .handleRaw("uploadTarball", ({ query, params, request }) =>
        Effect.andThen(
          runs(query),
          uploadTarball(request, params.name, params.sha256),
        ).pipe(Effect.catchTag("R2Error", (e) => Effect.die(e))),
      ),
  );

  const healthGroup = HttpApiBuilder.group(PkgApi, "Health", (handlers) =>
    handlers.handle("health", () => Effect.succeed({ ok: true })),
  );

  // Unlike `HttpApiBuilder.group`, the router defers a route's requirements
  // to request time rather than the layer build, so the services are
  // provided on the route effect itself.
  const installRoutes = HttpRouter.use((router) =>
    Effect.all([
      router.add("GET", "/", banner),
      router.add(
        "*",
        "/*",
        install.pipe(
          Effect.catchTag(storageFailures, (e) => Effect.die(e)),
          Effect.provide(services),
        ),
      ),
    ]),
  );

  return {
    fetch: Layer.mergeAll(HttpApiBuilder.layer(PkgApi), installRoutes).pipe(
      Layer.provide([registry, healthGroup]),
      Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
      Layer.provide(services),
      HttpRouter.toHttpEffect,
    ),
  };
}).pipe(Effect.provide(bindings));
