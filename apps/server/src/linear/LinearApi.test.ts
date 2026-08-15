import { assert, it, vi } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as LinearApi from "./LinearApi.ts";

const encodeSecret = (value: string): Uint8Array => new TextEncoder().encode(value);

function makeMemorySecretStore(initial?: string) {
  const values = new Map<string, Uint8Array>();
  if (initial !== undefined) {
    values.set(LinearApi.LINEAR_API_TOKEN_SECRET, encodeSecret(initial));
  }
  const store = {
    get: ((name) =>
      Effect.sync(() => {
        const value = values.get(name);
        return value === undefined ? Option.none() : Option.some(Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["get"],
    set: ((name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["set"],
    create: ((name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["create"],
    getOrCreateRandom: ((name, bytes) =>
      Effect.sync(() => {
        const existing = values.get(name);
        if (existing) return existing;
        const generated = new Uint8Array(bytes);
        values.set(name, generated);
        return generated;
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["getOrCreateRandom"],
    remove: ((name) =>
      Effect.sync(() => {
        values.delete(name);
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["remove"],
  } satisfies ServerSecretStore.ServerSecretStore["Service"];
  return store;
}

function graphqlResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function makeLayer(input: {
  readonly token?: string | null;
  readonly envToken?: string;
  readonly response: (request: HttpClientRequest.HttpClientRequest) => Response;
}) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, input.response(request))),
  );
  const secrets = makeMemorySecretStore(
    input.token === null ? undefined : (input.token ?? "lin_api_test"),
  );
  const layer = LinearApi.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_LINEAR_API_BASE_URL: "https://api.test.local/graphql",
            ...(input.envToken === undefined ? {} : { T3CODE_LINEAR_API_TOKEN: input.envToken }),
          },
        }),
      ),
    ),
  );
  return { execute, layer, secrets };
}

const viewerOk = {
  data: { viewer: { id: "u1", name: "Ada", email: "ada@example.com" } },
};

const issueNode = {
  id: "issue-1",
  identifier: "ENG-1",
  title: "Fix the thing",
  url: "https://linear.app/acme/issue/ENG-1",
  description: "Do the work.",
  priorityLabel: "High",
  state: { name: "In Progress", type: "started" },
  assignee: { name: "Ada" },
  team: { id: "team-1", key: "ENG" },
  labels: { nodes: [{ name: "bug" }] },
  children: { nodes: [] },
  attachments: { nodes: [] },
  comments: { nodes: [] },
};

it.effect("probeAuth reports unauthenticated when no token is configured", () => {
  const { layer } = makeLayer({
    token: null,
    response: () => graphqlResponse(viewerOk),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const status = yield* linear.probeAuth;
    assert.strictEqual(status.status, "unauthenticated");
    assert.strictEqual(status.hasStoredToken, false);
  }).pipe(Effect.provide(layer));
});

it.effect("probeAuth requires a viewer before reporting authenticated", () => {
  const { layer } = makeLayer({
    response: () => graphqlResponse({ data: { viewer: null } }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const status = yield* linear.probeAuth;
    assert.strictEqual(status.status, "unauthenticated");
    assert.strictEqual(status.hasStoredToken, true);
    assert.strictEqual(status.detail, "Linear did not return an account for this token.");
  }).pipe(Effect.provide(layer));
});

it.effect("probeAuth returns the Linear account when viewer is present", () => {
  const { layer } = makeLayer({
    response: () => graphqlResponse(viewerOk),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const status = yield* linear.probeAuth;
    assert.deepStrictEqual(status, {
      status: "authenticated",
      hasStoredToken: true,
      account: { name: "Ada", email: "ada@example.com" },
    });
  }).pipe(Effect.provide(layer));
});

it.effect("setToken reports unverified when Linear cannot be reached after save", () => {
  const { layer } = makeLayer({
    token: null,
    response: () => new Response("down", { status: 503 }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const status = yield* linear.setToken("lin_api_saved");
    assert.strictEqual(status.status, "unverified");
    assert.strictEqual(status.hasStoredToken, true);
    assert.strictEqual(status.detail, "Saved, but couldn't reach Linear to verify the token.");
  }).pipe(Effect.provide(layer));
});

it.effect("probeAuth reports unverified when a stored token cannot reach Linear", () => {
  const { layer } = makeLayer({
    response: () => new Response("down", { status: 503 }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const status = yield* linear.probeAuth;
    assert.strictEqual(status.status, "unverified");
    assert.strictEqual(status.hasStoredToken, true);
    assert.strictEqual(status.detail, "Couldn't reach Linear to verify the token.");
  }).pipe(Effect.provide(layer));
});

it.effect("clearToken does not claim the token was saved when Linear is down", () => {
  const { layer } = makeLayer({
    envToken: "lin_api_env",
    response: () => new Response("down", { status: 503 }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const status = yield* linear.clearToken;
    assert.strictEqual(status.status, "unverified");
    assert.strictEqual(status.hasStoredToken, false);
    assert.strictEqual(
      status.detail,
      "The saved token was removed, but Linear could not be reached.",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("fetchIssues continues when one selected issue is missing", () => {
  const { layer } = makeLayer({
    response: (request) => {
      const rawBody = (request.body as { readonly body?: Uint8Array }).body;
      const payload = JSON.parse(new TextDecoder().decode(rawBody)) as {
        readonly variables?: { readonly id?: string };
      };
      if (payload.variables?.id === "missing") {
        return graphqlResponse({
          data: { issue: null },
          errors: [{ message: "Entity not found" }],
        });
      }
      return graphqlResponse({ data: { issue: issueNode } });
    },
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const issues = yield* linear.fetchIssues({ ids: ["issue-1", "missing"] });
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0]?.identifier, "ENG-1");
  }).pipe(Effect.provide(layer));
});

it.effect("fetchIssues fails when Linear returns an issue together with errors", () => {
  const { layer } = makeLayer({
    response: () =>
      graphqlResponse({
        data: { issue: issueNode },
        errors: [{ message: "Comments connection timed out" }],
      }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const error = yield* linear.fetchIssues({ ids: ["issue-1"] }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "LinearRequestError");
  }).pipe(Effect.provide(layer));
});

it.effect("probeAuth reports unverified for a malformed GraphQL envelope", () => {
  const { layer } = makeLayer({
    response: () => graphqlResponse({}),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const status = yield* linear.probeAuth;
    assert.strictEqual(status.status, "unverified");
    assert.strictEqual(status.hasStoredToken, true);
    assert.strictEqual(status.detail, "Couldn't reach Linear to verify the token.");
  }).pipe(Effect.provide(layer));
});

it.effect("probeAuth reports unverified when the viewer field is missing", () => {
  const { layer } = makeLayer({
    response: () => graphqlResponse({ data: {} }),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const status = yield* linear.probeAuth;
    assert.strictEqual(status.status, "unverified");
    assert.strictEqual(status.hasStoredToken, true);
  }).pipe(Effect.provide(layer));
});

it.effect("fetchIssues fails on a malformed GraphQL envelope", () => {
  const { layer } = makeLayer({
    response: () => graphqlResponse({}),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const error = yield* linear.fetchIssues({ ids: ["issue-1"] }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "LinearRequestError");
    assert.strictEqual(error.detail, "Linear returned a malformed GraphQL response.");
  }).pipe(Effect.provide(layer));
});

it.effect("searchIssues fails on a malformed GraphQL envelope", () => {
  const { layer } = makeLayer({
    response: () => graphqlResponse({}),
  });
  return Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;
    const error = yield* linear.searchIssues({ query: "eng", limit: 10 }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "LinearRequestError");
    assert.strictEqual(error.detail, "Linear returned a malformed GraphQL response.");
  }).pipe(Effect.provide(layer));
});
