// @effect-diagnostics preferSchemaOverJson:off effectFnOpportunity:off
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitCafeApi from "./GitCafeApi.ts";
import * as GitCafeCredentials from "./GitCafeCredentials.ts";
import * as GitCafePullRequestProvider from "./GitCafePullRequestProvider.ts";

export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly host: string;
  readonly body: unknown;
  readonly redirect: string | undefined;
}

export function fakeGitCafe(
  routes: Record<string, unknown | ((request: SentRequest) => unknown)>,
  options: { readonly status?: number; readonly env?: NodeJS.ProcessEnv } = {},
) {
  const sent: Array<SentRequest> = [];
  const client = HttpClient.make(
    (request: HttpClientRequest.HttpClientRequest, _url, _signal, fiber) => {
      const url = new URL(request.url);
      assert.isTrue(url.pathname.startsWith("/api/"), url.pathname);
      assert.strictEqual(request.headers.authorization, "Bearer env-token");
      const entry: SentRequest = {
        method: request.method,
        path: url.pathname.slice("/api".length),
        query: url.searchParams,
        host: url.host,
        body:
          request.body._tag === "Uint8Array"
            ? decodeJson(new TextDecoder().decode(request.body.body))
            : undefined,
        redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
      };
      sent.push(entry);
      const route = routes[`${entry.method} ${entry.path}`];
      const response =
        route === undefined
          ? new Response(encodeJson({ type: "https://cafe.sh/errors/not-found" }), { status: 404 })
          : route instanceof Response
            ? route
            : new Response(encodeJson(typeof route === "function" ? route(entry) : route), {
                status: options.status ?? 200,
              });
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    },
  );
  const layer = GitCafeApi.layer.pipe(
    Layer.provide(GitCafeCredentials.layer),
    Layer.provide(TestSourceControlHost.layer()),
    Layer.provide(
      Layer.succeed(HostProcess.Environment, options.env ?? { CAFE_TOKEN: "env-token" }),
    ),
    Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  const writes = () =>
    sent.filter((request) => request.method !== "GET").map((r) => `${r.method} ${r.path}`);
  return { layer, sent, writes };
}

export const target = { cwd: "/repo", host: "git.cafe", repository: "owner/repo", number: 7 };

export const timestamp = "2026-09-12T12:00:00Z";

export const headOid = "0123456789abcdef0123456789abcdef01234567";

export const baseOid = "89abcdef0123456789abcdef0123456789abcdef";

export const actor = {
  kind: "local",
  actorId: "act_one",
  handle: "alice",
  displayName: null,
  avatarUrl: "/avatars/one",
};

export const pull = {
  id: "pr_one",
  number: 7,
  title: "Change",
  state: "open",
  draft: false,
  sourceBranch: "feature",
  targetBranch: "main",
  headOid,
  observedBaseOid: baseOid,
  mergeRoute: "provider",
  author: actor,
  createdAt: timestamp,
  updatedAt: timestamp,
  version: 4,
  description: "Body",
  closedAt: null,
  mergedAt: null,
  sourceRepo: null,
  capabilities: { comment: true, review: true, merge: true, edit: true, moderate: true },
};

export const labels = [
  { id: "label_bug", name: "bug", color: "#d73a4a", description: null },
  { id: "label_docs", name: "docs", color: "#0075ca", description: "Documentation" },
];

export const root = {
  id: "root",
  threadId: "root",
  version: 2,
  author: actor,
  body: "Review",
  path: "file.ts",
  line: 3,
  side: "right",
  createdAt: timestamp,
  commitOid: headOid,
  resolvedAt: null,
  capabilities: {
    edit: true,
    hide: false,
    unhide: false,
    delete: false,
    resolve: true,
    unresolve: false,
  },
};

export const stack = (
  members: ReadonlyArray<{ number: number; headOid: string; state?: string }>,
): Record<string, unknown> => ({
  "GET /repos/owner/repo/pulls/7/stack": {
    stack: {
      id: "stack-one",
      number: 3,
      revision: 5,
      landingBase: "main",
      members: members.map((member, index) => ({
        pullRequestNumber: member.number,
        title: `Layer ${member.number}`,
        state: member.state ?? "open",
        draft: false,
        sourceBranch: `layer-${member.number}`,
        position: index + 1,
      })),
    },
  },
  ...Object.fromEntries(
    members.map((member) => [
      `GET /repos/owner/repo/pulls/${member.number}`,
      { ...pull, number: member.number, headOid: member.headOid },
    ]),
  ),
});

export const assertRequestId = (body: unknown) =>
  assert.match(
    (body as { readonly requestId?: unknown } | undefined)?.requestId as string,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
