import { assert } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as EntireApi from "./EntireApi.ts";
import * as EntireCli from "./EntireCli.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export const API_ORIGIN = "https://aws-us-east-2.api.entire.io";
export const REPO_ID = "01J0REPO";
/** A project's processing cell, apart from the repository's. */
export const PROJECT_CELL_ORIGIN = "https://aws-eu-central-1.api.entire.io";
export const PROJECT_ID = "01J0PROJECT";
/** Where repository-scoped project trails of `gh/acme/*` live. */
export const PROJECT_TRAILS = "/api/v1/gh/acme/trails";
/** Where the owning project's trail list is addressed by id. */
export const TRAIL_COLLECTION = "/api/v1/trails";
export const REMOTE_URL = "entire://aws-us-east-2.entire.io/gh/acme/web.git";

export interface SentRequest {
  readonly method: string;
  readonly origin: string;
  /** Below `/api/v1/repos/{repoId}`, or the whole path of a project trail route. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly authorization: string | undefined;
  readonly body: unknown;
  readonly redirect: string | undefined;
}

/** A route's answer with a status of its own, where the rest of the server answers 200. */
export class Answer {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    this.status = status;
    this.body = body;
  }
}

type Route = unknown | ((request: SentRequest) => unknown);

const fakeCheckout = (operation: string, cwd: string) =>
  Effect.fail(new GitCommandError({ operation, command: "git", cwd, detail: "fake checkout" }));

/**
 * A fake Entire cell behind the real EntireApi, with a fake CLI that names it. Routes are keyed
 * `"<METHOD> <path>"`; an unrouted request answers 404.
 */
export function fakeEntire(
  routes: Record<string, Route>,
  options: {
    readonly status?: number;
    readonly etag?: string;
    readonly apiUrl?: string;
    readonly remoteUrl?: string | null;
    readonly coordinates?: {
      readonly repoId?: string;
      readonly projectId?: string | null;
      readonly cluster?: string;
    };
    readonly git?: Partial<SourceControlHost.SourceControlHost["Service"]["git"]>;
  } = {},
) {
  const sent: Array<SentRequest> = [];
  const references: Array<string> = [];
  let tokenReads = 0;
  let invalidations = 0;
  const client = HttpClient.make(
    (request: HttpClientRequest.HttpClientRequest, _url, _signal, fiber) => {
      const url = new URL(request.url);
      const prefix = `/api/v1/repos/${options.coordinates?.repoId ?? REPO_ID}`;
      const repositoryScoped = url.pathname.startsWith(prefix);
      assert.isTrue(
        repositoryScoped ||
          url.pathname.startsWith(PROJECT_TRAILS) ||
          url.pathname === TRAIL_COLLECTION,
        url.pathname,
      );
      const entry: SentRequest = {
        method: request.method,
        origin: url.origin,
        path: repositoryScoped ? url.pathname.slice(prefix.length) : url.pathname,
        headers: request.headers,
        query: url.searchParams,
        authorization: request.headers.authorization,
        body:
          request.body._tag === "Uint8Array"
            ? decodeJson(new TextDecoder().decode(request.body.body))
            : undefined,
        redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
      };
      sent.push(entry);
      const route = routes[`${entry.method} ${entry.path}`];
      const answered = typeof route === "function" ? route(entry) : route;
      const response =
        route === undefined
          ? new Response(encodeJson({ title: "Not Found", detail: "no such route" }), {
              status: 404,
            })
          : new Response(encodeJson(answered instanceof Answer ? answered.body : answered), {
              status: answered instanceof Answer ? answered.status : (options.status ?? 200),
              headers: options.etag === undefined ? {} : { etag: options.etag },
            });
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    },
  );
  const cli = Layer.succeed(
    EntireCli.EntireCli,
    EntireCli.EntireCli.of({
      repository: Effect.fn("entireTestServer.repository")((reference) =>
        Effect.sync(() => {
          references.push(reference);
          return {
            repoId: options.coordinates?.repoId ?? REPO_ID,
            projectId:
              options.coordinates?.projectId === undefined
                ? PROJECT_ID
                : options.coordinates.projectId,
            apiUrl: options.apiUrl ?? API_ORIGIN,
            cluster: options.coordinates?.cluster ?? "aws-us-east-2.entire.io",
          };
        }),
      ),
      token: Effect.sync(() => {
        tokenReads++;
        return Redacted.make("ent_token");
      }),
      invalidateToken: Effect.sync(() => {
        invalidations++;
      }),
      viewer: Effect.succeed("alice"),
      cells: Effect.succeed([
        { slug: "aws-us-east-2", jurisdiction: "us", apiUrl: API_ORIGIN },
        { slug: "aws-eu-central-1", jurisdiction: "eu", apiUrl: PROJECT_CELL_ORIGIN },
      ]),
    }),
  );
  const remoteUrl = options.remoteUrl === undefined ? REMOTE_URL : options.remoteUrl;
  const host = TestSourceControlHost.layer({
    git: {
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      // A fake checkout holds no commits, and no git command finds anything in it.
      resolveCommit: ({ cwd }) => fakeCheckout("resolveCommit", cwd),
      fetchRemoteTrackingBranch: ({ cwd }) => fakeCheckout("fetchRemoteTrackingBranch", cwd),
      execute: ({ cwd }) => fakeCheckout("execute", cwd),
      readConfigValue: () => Effect.succeed(remoteUrl),
      ...options.git,
    },
  });
  const layer = EntireApi.layer.pipe(
    Layer.provideMerge(cli),
    Layer.provideMerge(host),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  return {
    layer,
    sent,
    references,
    tokenReads: () => tokenReads,
    invalidations: () => invalidations,
    writes: () =>
      sent.filter((request) => request.method !== "GET").map((r) => `${r.method} ${r.path}`),
  };
}
