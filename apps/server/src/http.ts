import Mime from "@effect/platform-node/Mime";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
} from "effect/unstable/http";
import { OtlpTracer } from "effect/unstable/observability";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { resolveAttachmentPathById } from "./attachmentStore.ts";
import { resolveStaticDir, ServerConfig } from "./config.ts";
import { BrowserTraceCollector } from "./observability/Services/BrowserTraceCollector.ts";
import { ProcessRunner, type ProcessRunnerShape } from "./processRunner.ts";
import {
  buildGitHubProjectImageCandidateUrls,
  buildGitHubRepositoryPageUrl,
  parseGitHubRepositoryImageGraphqlResponse,
  resolveGitHubRepositoryRef,
  type GitHubRepositoryRef,
  type GitHubRepositoryImageMetadata,
} from "./project/githubProjectImage.ts";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver.ts";
import { RepositoryIdentityResolver } from "./project/Services/RepositoryIdentityResolver.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import { respondToAuthError } from "./auth/http.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import {
  browserApiCorsAllowedHeaders,
  browserApiCorsAllowedMethods,
  browserApiCorsHeaders,
} from "./httpCors.ts";

const PROJECT_FAVICON_CACHE_CONTROL = "public, max-age=3600";
const PROJECT_FAVICON_REMOTE_FETCH_TIMEOUT_MS = 5_000;
const PROJECT_FAVICON_REMOTE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const PROJECT_FAVICON_REMOTE_USER_AGENT = "T3 Code project favicon resolver";
const PROJECT_FAVICON_GITHUB_CLI_TIMEOUT_MS = 2_500;
const PROJECT_FAVICON_GITHUB_CLI_MAX_OUTPUT_BYTES = 128 * 1024;
const PROJECT_FAVICON_GITHUB_GRAPHQL_QUERY = `
  query RepositoryProjectImage($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      openGraphImageUrl
      owner {
        avatarUrl(size: 64)
      }
    }
  }
`;
const FALLBACK_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;
const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export const browserApiCorsLayer = HttpRouter.cors({
  allowedMethods: [...browserApiCorsAllowedMethods],
  allowedHeaders: [...browserApiCorsAllowedHeaders],
  maxAge: 600,
});

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const requireAuthenticatedRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(request);
});

const fetchGitHubProjectImageMetadataWithCli = (
  processRunner: ProcessRunnerShape,
  repository: GitHubRepositoryRef,
): Effect.Effect<GitHubRepositoryImageMetadata | null> =>
  processRunner
    .run({
      command: "gh",
      args: [
        "api",
        "graphql",
        "-f",
        `query=${PROJECT_FAVICON_GITHUB_GRAPHQL_QUERY}`,
        "-F",
        `owner=${repository.owner}`,
        "-F",
        `name=${repository.name}`,
      ],
      env: { GH_PROMPT_DISABLED: "1" },
      maxOutputBytes: PROJECT_FAVICON_GITHUB_CLI_MAX_OUTPUT_BYTES,
      outputMode: "truncate",
      timeout: Duration.millis(PROJECT_FAVICON_GITHUB_CLI_TIMEOUT_MS),
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.map((result) =>
        result.code === 0 && !result.timedOut
          ? parseGitHubRepositoryImageGraphqlResponse(result.stdout)
          : null,
      ),
      Effect.catch(() => Effect.succeed(null)),
    );

const fetchProjectFaviconText = (
  httpClient: HttpClient.HttpClient,
  url: string,
): Effect.Effect<string | null> =>
  httpClient
    .get(url, {
      headers: { "User-Agent": PROJECT_FAVICON_REMOTE_USER_AGENT },
    })
    .pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300 ? response.text : Effect.succeed(null),
      ),
      Effect.timeoutOption(PROJECT_FAVICON_REMOTE_FETCH_TIMEOUT_MS),
      Effect.map((result) => (Option.isSome(result) ? result.value : null)),
      Effect.catch(() => Effect.succeed(null)),
    );

const fetchProjectFaviconRemoteImage = (
  httpClient: HttpClient.HttpClient,
  url: string,
): Effect.Effect<{ readonly body: Uint8Array; readonly contentType: string } | null> =>
  httpClient
    .get(url, {
      headers: { "User-Agent": PROJECT_FAVICON_REMOTE_USER_AGENT },
    })
    .pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          if (response.status < 200 || response.status >= 300) {
            return null;
          }

          const contentType = response.headers["content-type"]?.split(";")[0]?.trim() ?? "";
          if (!contentType.toLowerCase().startsWith("image/")) {
            return null;
          }

          const contentLength = Number(response.headers["content-length"] ?? "0");
          if (contentLength > PROJECT_FAVICON_REMOTE_IMAGE_MAX_BYTES) {
            return null;
          }

          const body = new Uint8Array(yield* response.arrayBuffer);
          if (body.byteLength > PROJECT_FAVICON_REMOTE_IMAGE_MAX_BYTES) {
            return null;
          }

          return { body, contentType };
        }),
      ),
      Effect.timeoutOption(PROJECT_FAVICON_REMOTE_FETCH_TIMEOUT_MS),
      Effect.map((result) => (Option.isSome(result) ? result.value : null)),
      Effect.catch(() => Effect.succeed(null)),
    );

const resolveGitHubProjectFavicon = (projectCwd: string) =>
  Effect.gen(function* () {
    const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects(3));
    const processRunner = yield* ProcessRunner;
    const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
    const repositoryIdentity = yield* repositoryIdentityResolver.resolve(projectCwd);
    const githubRepository = resolveGitHubRepositoryRef(repositoryIdentity);
    if (!githubRepository) {
      return null;
    }

    const repositoryImageMetadata = yield* fetchGitHubProjectImageMetadataWithCli(
      processRunner,
      githubRepository,
    );
    const repositoryHtml = repositoryImageMetadata
      ? null
      : yield* fetchProjectFaviconText(httpClient, buildGitHubRepositoryPageUrl(githubRepository));
    const imageUrls = buildGitHubProjectImageCandidateUrls({
      repository: githubRepository,
      repositoryImageMetadata,
      repositoryHtml,
    });

    for (const imageUrl of imageUrls) {
      const image = yield* fetchProjectFaviconRemoteImage(httpClient, imageUrl);
      if (image) {
        return image;
      }
    }

    return null;
  });

export const serverEnvironmentRouteLayer = HttpRouter.add(
  "GET",
  "/.well-known/t3/environment",
  Effect.gen(function* () {
    const descriptor = yield* Effect.service(ServerEnvironment).pipe(
      Effect.flatMap((serverEnvironment) => serverEnvironment.getDescriptor),
    );
    return HttpServerResponse.jsonUnsafe(descriptor, {
      status: 200,
      headers: browserApiCorsHeaders,
    });
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.text("Trace export failed.", { status: 502 })),
        ),
      );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const attachmentsRouteLayer = HttpRouter.add(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rawRelativePath = url.value.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
    const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
    if (!normalizedRelativePath) {
      return HttpServerResponse.text("Invalid attachment path", { status: 400 });
    }

    const isIdLookup =
      !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
    const filePath = isIdLookup
      ? resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: normalizedRelativePath,
        })
      : resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: normalizedRelativePath,
        });
    if (!filePath) {
      return HttpServerResponse.text(isIdLookup ? "Not Found" : "Invalid attachment path", {
        status: isIdLookup ? 404 : 400,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const projectFaviconRouteLayer = HttpRouter.add(
  "GET",
  "/api/project-favicon",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const projectCwd = url.value.searchParams.get("cwd");
    if (!projectCwd) {
      return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    }

    const githubProjectFavicon = yield* resolveGitHubProjectFavicon(projectCwd);
    if (githubProjectFavicon) {
      return HttpServerResponse.uint8Array(githubProjectFavicon.body, {
        status: 200,
        contentType: githubProjectFavicon.contentType,
        headers: {
          "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
        },
      });
    }

    const faviconResolver = yield* ProjectFaviconResolver;
    const faviconFilePath = yield* faviconResolver.resolvePath(projectCwd);
    if (!faviconFilePath) {
      return HttpServerResponse.text(FALLBACK_PROJECT_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: {
          "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
        },
      });
    }

    return yield* HttpServerResponse.file(faviconFilePath, {
      status: 200,
      headers: {
        "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir = config.staticDir ?? (config.devUrl ? yield* resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem
      .readFile(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
    });
  }),
);
