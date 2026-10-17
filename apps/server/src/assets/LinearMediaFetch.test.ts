import { AssetResource, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientResponse,
  HttpServerResponse,
  HttpRouter,
  type HttpClientRequest,
} from "effect/http";
import * as IssueTrackerHost from "@t3tools/issue-tracker-core/server/IssueTrackerHost";

import * as IssueService from "../issue/IssueService.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { issueTrackerSecretName } from "../issue/IssueTrackerHostLive.ts";
import { linearMediaFetchUrl, linearMediaResponse } from "./LinearMediaFetch.ts";
import { issueAssetUrl } from "./AssetAccess.ts";
import { layerAssetRoute } from "../http.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";

const issue = {
  projectId: ProjectId.make("linear-project"),
  tracker: IssueTrackerKind.make("linear"),
  host: "linear.app",
  scope: "workspace/ENG",
  key: "ENG-12",
  connectionId: "account-b",
};
const url = "https://uploads.linear.app/workspace/file/screenshot.png";
const source = {
  tracker: issue.tracker,
  host: "linear.app",
  scope: issue.scope,
  connectionId: issue.connectionId,
};
const asset = { issue, url, expiresAt: Number.MAX_SAFE_INTEGER };
const decodeAssetResource = Schema.decodeUnknownSync(AssetResource);
const bytes = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);

function fixture(
  respond = (_request: HttpClientRequest.HttpClientRequest): Response =>
    new Response(bytes, { headers: { "content-type": "image/png" } }),
) {
  let sources: ReadonlyArray<IssueService.ProjectTrackerBinding> = [source];
  const tokens = new Map([
    [issueTrackerSecretName(issue.tracker), "default-key"],
    [issueTrackerSecretName(issue.tracker, "account-a"), "account-a-key"],
    [issueTrackerSecretName(issue.tracker, "account-b"), "account-b-key"],
  ]);
  const reads: string[] = [];
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const redirects: (RequestInit | undefined)[] = [];
  let signingKey = new Uint8Array(32).fill(7);
  const issueLayer = Layer.mock(IssueService.IssueService)({
    sources: (projectId) => Effect.succeed(projectId === issue.projectId ? sources : []),
  });
  const nativeLayer = Layer.mergeAll(
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      getOrCreateRandom: () => Effect.sync(() => signingKey),
      get: (name) =>
        Effect.sync(() => {
          reads.push(name);
          return Option.fromUndefinedOr(tokens.get(name)).pipe(
            Option.map((token) => new TextEncoder().encode(token)),
          );
        }),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          redirects.push(
            Option.getOrUndefined(yield* Effect.serviceOption(FetchHttpClient.RequestInit)),
          );
          requests.push(request);
          return HttpClientResponse.fromWeb(request, respond(request));
        }),
      ),
    ),
  );
  const layer = Layer.merge(issueLayer, nativeLayer);
  return {
    layer,
    issueLayer,
    nativeLayer,
    reads,
    requests,
    redirects,
    tokens,
    setSources: (next: typeof sources) => {
      sources = next;
    },
    setSigningKey: (next: typeof signingKey) => {
      signingKey = next;
    },
  };
}

describe("Linear media", () => {
  it.effect(
    "serves signed images with production route context and rejects stale sources or foreign keys",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const dependencies = Layer.mergeAll(
          f.nativeLayer,
          NodeHttpPlatform.layer,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-linear-media-route-" }),
          Layer.mock(WorkspacePaths.WorkspacePaths)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({}),
          Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
          Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
          Layer.mock(GitHubCredentials.GitHubCredentials)({}),
        ).pipe(Layer.provideMerge(NodeServices.layer));
        const signed = yield* issueAssetUrl({
          resource: { _tag: "linear-media", issue, url },
        }).pipe(Effect.provide(Layer.merge(f.issueLayer, dependencies)));
        const app = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              layerAssetRoute.pipe(Layer.provide(f.issueLayer), Layer.provideMerge(dependencies)),
              { disableLogger: true },
            ),
          ),
          (server) => Effect.promise(() => server.dispose()),
        );
        const response = yield* Effect.promise(() =>
          app.handler(
            new Request("https://destination.example.invalid" + signed.relativeUrl, {
              headers: { authorization: "client-key", cookie: "private-cookie" },
            }),
          ),
        );
        expect(response.status).toBe(200);
        expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(bytes);
        expect(
          f.requests.map((request) => ({
            url: request.url,
            authorization: request.headers.authorization,
            cookie: request.headers.cookie,
          })),
        ).toEqual([{ url, authorization: "account-b-key", cookie: undefined }]);
        expect(f.reads).toEqual([issueTrackerSecretName(issue.tracker, "account-b")]);
        f.setSources([]);
        expect(
          (yield* Effect.promise(() =>
            app.handler(new Request("https://destination.example.invalid" + signed.relativeUrl)),
          )).status,
        ).toBe(404);
        f.setSources([source]);
        f.setSigningKey(new Uint8Array(32).fill(8));
        expect(
          (yield* Effect.promise(() =>
            app.handler(new Request("https://foreign.example.invalid" + signed.relativeUrl)),
          )).status,
        ).toBe(404);
        expect(f.requests).toHaveLength(1);
        expect(f.reads).toHaveLength(1);
      }).pipe(TestClock.withLive, Effect.scoped),
  );
  it("keeps the original media URL and selected issue account in the asset resource", () => {
    const resource = { _tag: "linear-media", issue, url };
    expect(decodeAssetResource(resource)).toEqual(resource);
  });

  it("accepts only the native HTTPS upload origin", () => {
    for (const candidate of [
      "https://uploads.linear.app.evil.invalid/a.png",
      "http://uploads.linear.app/a.png",
      "https://uploads.linear.app:444/a.png",
      "https://user@uploads.linear.app/a.png",
      "https://uploads.linear.app@evil.invalid/a.png",
      "https://linear.app/a.png",
      "not a URL",
      url + "?" + "a".repeat(2048),
    ])
      expect(linearMediaFetchUrl(candidate)).toBeNull();
    expect(linearMediaFetchUrl(url + "?download=1#view")).toBe(url + "?download=1");
  });

  it.effect("streams the image with account B's fresh native API key and no client headers", () => {
    const f = fixture();
    return Effect.gen(function* () {
      for (const key of ["account-b-key", "rotated-b-key"]) {
        f.tokens.set(issueTrackerSecretName(issue.tracker, issue.connectionId), key);
        const response = yield* linearMediaResponse(asset, {
          authorization: "client-key",
          cookie: "secret",
        });
        expect(response.status).toBe(200);
        expect(response.headers["cache-control"]).toBe("private, no-store");
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers.authorization).toBeUndefined();
        const web = HttpServerResponse.toWeb(response);
        expect(new Uint8Array(yield* Effect.promise(() => web.arrayBuffer()))).toEqual(bytes);
      }
      expect(f.requests.map((request) => request.headers.authorization)).toEqual([
        "account-b-key",
        "rotated-b-key",
      ]);
      expect(f.requests.every((request) => request.headers.cookie === undefined)).toBe(true);
      expect(f.reads).toEqual([
        issueTrackerSecretName(issue.tracker, "account-b"),
        issueTrackerSecretName(issue.tracker, "account-b"),
      ]);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("uses only the legacy default when the source has no selected account", () => {
    const f = fixture();
    const { connectionId: _connectionId, ...legacy } = issue;
    f.setSources([{ tracker: issue.tracker, host: "linear.app", scope: issue.scope }]);
    return Effect.gen(function* () {
      expect((yield* linearMediaResponse({ ...asset, issue: legacy }, {})).status).toBe(200);
      expect(f.requests[0]?.headers.authorization).toBe("default-key");
      expect(f.reads).toEqual([issueTrackerSecretName(issue.tracker)]);
    }).pipe(
      Effect.provideService(IssueTrackerHost.ConnectionId, "account-a"),
      Effect.provide(f.layer),
      Effect.scoped,
    );
  });

  it.effect(
    "refuses missing, changed, or foreign sources before any credential or HTTP read",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        for (const input of [
          { ...issue, connectionId: "account-a" },
          { ...issue, connectionId: "removed" },
          { ...issue, connectionId: undefined },
          { ...issue, tracker: IssueTrackerKind.make("jira") },
          { ...issue, host: "other.invalid" },
          { ...issue, projectId: ProjectId.make("foreign-project") },
          { ...issue, scope: "other/ENG" },
          { ...issue, scope: "workspace" },
        ])
          expect((yield* linearMediaResponse({ ...asset, issue: input }, {})).status).toBe(404);
        f.setSources([]);
        expect((yield* linearMediaResponse(asset, {})).status).toBe(404);
        expect(f.reads).toEqual([]);
        expect(f.requests).toEqual([]);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    },
  );

  it.effect(
    "allows another team in the same workspace and refuses a removed account key without fallback",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        expect(
          (yield* linearMediaResponse(
            { ...asset, issue: { ...issue, scope: "WORKSPACE/OTHER" } },
            {},
          )).status,
        ).toBe(200);
        f.tokens.delete(issueTrackerSecretName(issue.tracker, "account-b"));
        expect((yield* linearMediaResponse(asset, {})).status).toBe(404);
        expect(f.requests).toHaveLength(1);
        expect(f.reads).toEqual([
          issueTrackerSecretName(issue.tracker, "account-b"),
          issueTrackerSecretName(issue.tracker, "account-b"),
        ]);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    },
  );

  it.effect(
    "keeps keys on the exact upload origin across manual redirects and preserves ranges",
    () => {
      const f = fixture((request) => {
        if (request.url === url)
          return new Response(null, {
            status: 302,
            headers: { location: "https://objects.example.invalid/recording.mp4?signature=fake" },
          });
        if (request.url.includes("objects.example.invalid"))
          return new Response(null, {
            status: 302,
            headers: { location: "https://uploads.linear.app/final" },
          });
        return new Response(bytes.subarray(0, 8), {
          status: 206,
          headers: {
            "content-type": "video/mp4",
            "content-range": "bytes 4-11/12",
            "content-length": "8",
            "accept-ranges": "bytes",
            etag: '"image"',
          },
        });
      });
      return Effect.gen(function* () {
        const response = yield* linearMediaResponse(asset, {
          range: "bytes=4-11",
          "if-range": '"image"',
        });
        expect(response.status).toBe(206);
        expect(response.headers["content-range"]).toBe("bytes 4-11/12");
        expect(response.headers["content-type"]).toBe("video/mp4");
        expect(response.headers["content-length"]).toBe("8");
        expect(f.requests.map((request) => request.headers.authorization)).toEqual([
          "account-b-key",
          undefined,
          "account-b-key",
        ]);
        expect(
          f.requests.every(
            (request) =>
              request.headers.range === "bytes=4-11" &&
              request.headers["if-range"] === '"image"' &&
              request.headers["accept-encoding"] === "identity",
          ),
        ).toBe(true);
        expect(f.redirects).toEqual([
          { redirect: "manual" },
          { redirect: "manual" },
          { redirect: "manual" },
        ]);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    },
  );

  it.effect("bounds redirects and refuses HTTP or userinfo redirect targets", () => {
    return Effect.gen(function* () {
      for (const location of [
        url,
        "http://uploads.linear.app/a.png",
        "https://user@uploads.linear.app/a.png",
        "https://foreign.invalid/a.png",
      ]) {
        const f = fixture(() => new Response(null, { status: 302, headers: { location } }));
        expect((yield* linearMediaResponse(asset, {}).pipe(Effect.provide(f.layer))).status).toBe(
          502,
        );
        expect(f.requests).toHaveLength(
          location.startsWith("http:") || location.includes("user@") ? 1 : 4,
        );
        if (location.includes("foreign.invalid"))
          expect(
            f.requests.slice(1).every((request) => request.headers.authorization === undefined),
          ).toBe(true);
      }
    }).pipe(Effect.scoped);
  });

  it.effect("refuses expired or foreign media before reading a key", () => {
    const f = fixture();
    return Effect.gen(function* () {
      for (const input of [
        { ...asset, expiresAt: 0 },
        { ...asset, url: "https://other.invalid/a.png" },
      ])
        expect((yield* linearMediaResponse(input, {})).status).toBe(404);
      expect(f.reads).toEqual([]);
      expect(f.requests).toEqual([]);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("stops an upstream request after the native request timeout", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const response = yield* linearMediaResponse(asset, {}).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("30 seconds");
      expect((yield* Fiber.join(response)).status).toBe(502);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("does not expose upstream error bodies or entity headers", () =>
    Effect.gen(function* () {
      for (const status of [401, 403, 404, 500]) {
        const f = fixture(
          () =>
            new Response("private error", {
              status,
              headers: { "content-length": "13", "content-type": "text/html" },
            }),
        );
        const response = yield* linearMediaResponse(asset, {}).pipe(Effect.provide(f.layer));
        expect(response.status).toBe(status === 500 ? 502 : status);
        expect(response.headers["content-length"]).toBeUndefined();
        expect(yield* Effect.promise(() => HttpServerResponse.toWeb(response).text())).toBe("");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("keeps non-media responses off this origin and sandboxes SVG", () =>
    Effect.gen(function* () {
      for (const [contentType, path, expected] of [
        ["text/html", "/page.html", 415],
        ["application/octet-stream", "/image.png", 200],
        ["image/svg+xml; charset=utf-8", "/image.svg", 200],
      ] as const) {
        const f = fixture(() => new Response("fake", { headers: { "content-type": contentType } }));
        const response = yield* linearMediaResponse(
          { ...asset, url: "https://uploads.linear.app" + path },
          {},
        ).pipe(Effect.provide(f.layer));
        expect(response.status).toBe(expected);
        if (path.endsWith(".svg"))
          expect(response.headers["content-security-policy"]).toBe(
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          );
      }
    }).pipe(Effect.scoped),
  );
});
