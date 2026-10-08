import { assert, it, vi } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as LinearApi from "./LinearApi.ts";
import * as LinearIssueProvider from "./LinearIssueProvider.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { ProviderListCursor } from "./IssueProvider.ts";

const bytes = (value: string) => new TextEncoder().encode(value);
const Json = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(Json);
const encodeJson = Schema.encodeSync(Json);
const pool = (...credentials: ReadonlyArray<readonly [credentialId: string, token: string]>) =>
  encodeJson({
    version: 1,
    credentials: credentials.map(([credentialId, token]) => ({ credentialId, token })),
  });

function memorySecrets(
  initial: Readonly<Record<string, string>> = {},
  options: {
    readonly failCredentialReadsAfterWrite?: boolean;
  } = {},
) {
  const values = new Map<string, Uint8Array>();
  let credentialsWritten = false;
  for (const [name, value] of Object.entries(initial)) values.set(name, bytes(value));
  const service = ServerSecretStore.ServerSecretStore.of({
    get: (name) => {
      if (
        name === "issue-trackers.linear.credentials" &&
        credentialsWritten &&
        options.failCredentialReadsAfterWrite === true
      ) {
        return Effect.fail(
          new ServerSecretStore.SecretStoreReadError({ resource: name, cause: "test" }),
        );
      }
      return Effect.sync(() => {
        const value = values.get(name);
        return value === undefined ? Option.none() : Option.some(value);
      });
    },
    set: (name, value) =>
      Effect.sync(() => {
        if (name === "issue-trackers.linear.credentials") credentialsWritten = true;
        values.set(name, value);
      }),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: (name, size) =>
      Effect.sync(() => {
        const value = values.get(name) ?? new Uint8Array(size);
        values.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  });
  return { service, values };
}

function makeLayer(input: {
  readonly envToken?: string;
  readonly credentials?: string;
  readonly failCredentialReadsAfterWrite?: boolean;
  readonly response: (body: Record<string, unknown>, authorization: string | undefined) => unknown;
}) {
  const requests: Array<{ body: Record<string, unknown>; authorization: string | undefined }> = [];
  const secrets = memorySecrets(
    {
      ...(input.credentials === undefined
        ? {}
        : { "issue-trackers.linear.credentials": input.credentials }),
    },
    {
      ...(input.failCredentialReadsAfterWrite === undefined
        ? {}
        : { failCredentialReadsAfterWrite: input.failCredentialReadsAfterWrite }),
    },
  );
  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
    const raw = (request.body as { readonly body?: Uint8Array }).body;
    const body = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    const authorization = request.headers.authorization;
    requests.push({ body, authorization });
    const response = input.response(body, authorization);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        response instanceof Response ? response : Response.json(response),
      ),
    );
  });
  const layer = LinearApi.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.service)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_LINEAR_API_BASE_URL: "https://linear.test",
            ...(input.envToken === undefined ? {} : { T3CODE_LINEAR_API_TOKEN: input.envToken }),
          },
        }),
      ),
    ),
  );
  return {
    layer,
    requests,
    values: secrets.values,
  };
}

it.effect("reports a disconnected Linear account without making a request", () => {
  const response = vi.fn(() => ({}));
  const { layer } = makeLayer({ response });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    assert.deepStrictEqual(yield* api.connection, {
      status: "unauthenticated",
      hasStoredToken: false,
      accountName: null,
      accountEmail: null,
      projects: [],
      accounts: [],
    });
    assert.strictEqual(response.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("does not route an absent environment token through a saved account", () => {
  const { layer, requests } = makeLayer({
    credentials: pool(["user-1", "saved-key"]),
    response: () => ({}),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const error = yield* Effect.flip(api.getViewer({}));
    assert.strictEqual(error.reason, "unauthenticated");
    assert.deepStrictEqual(requests, []);
  }).pipe(Effect.provide(layer));
});

it.effect("uses the environment token for environment-bound teams beside saved accounts", () => {
  const { layer, requests } = makeLayer({
    envToken: "lin_api_env",
    credentials: pool(["user-1", "lin_api_saved"]),
    response: () => ({ data: { viewer: { id: "viewer" } } }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.getViewer({});
    yield* api.getViewer({ credentialId: "user-1" });

    assert.deepStrictEqual(
      requests.map(({ authorization }) => authorization),
      ["lin_api_env", "lin_api_saved"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("reports the environment account beside saved accounts", () => {
  const { layer } = makeLayer({
    envToken: "lin_api_env",
    credentials: pool(["user-1", "lin_api_saved"]),
    response: (_body, authorization) => ({
      data: {
        viewer: {
          id: authorization === "lin_api_env" ? "env-user" : "user-1",
          name: authorization === "lin_api_env" ? "Environment account" : "Saved account",
          email: null,
        },
        teams: {
          nodes: [
            authorization === "lin_api_env"
              ? { id: "team-env", key: "ENV", name: "Environment" }
              : { id: "team-saved", key: "SAVED", name: "Saved" },
          ],
        },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const connection = yield* api.connection;

    assert.strictEqual(connection.accounts[0]?.projects[0]?.key, "SAVED");
    assert.strictEqual(connection.environmentAccount?.projects[0]?.key, "ENV");
    assert.strictEqual(connection.projects[0]?.key, "ENV");
  }).pipe(Effect.provide(layer));
});

it.effect("keeps Linear list continuation when the API page cap is reached", () => {
  const { layer } = makeLayer({
    envToken: "lin_api_test",
    response: () => ({
      data: {
        issues: {
          nodes: [
            {
              id: "issue-1",
              identifier: "ENG-1",
              number: 1,
              title: "First issue",
              url: "https://linear.app/acme/issue/ENG-1",
              description: null,
              createdAt: "2026-08-17T00:00:00.000Z",
              updatedAt: "2026-08-17T00:00:00.000Z",
              completedAt: null,
              canceledAt: null,
              state: { name: "Open", type: "started" },
              creator: null,
              assignee: null,
              labels: { nodes: [] },
            },
          ],
          pageInfo: { hasNextPage: true, hasPreviousPage: false },
        },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const page = yield* api.listIssues({
      teamKey: "ENG",
      state: "open",
      involvement: "all",
      viewer: "user-1",
      limit: 500,
    });

    assert.isTrue(page.truncated);
  }).pipe(Effect.provide(layer));
});

it.effect("searches an issue key as that team's issue number", () => {
  const { layer, requests } = makeLayer({
    envToken: "lin_api_test",
    response: () => ({
      data: { issues: { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } } },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const base = {
      teamKey: "ENG",
      state: "all",
      involvement: "all",
      viewer: "u",
      limit: 5,
    } as const;
    for (const query of ["eng-12", "#12", "12", "OPS-12", "crash"]) {
      yield* api.listIssues({ ...base, query });
    }
    const numberClauses = requests.map(({ body }) =>
      ((body.variables as { filter: { or: Array<Record<string, unknown>> } }).filter.or ?? []).find(
        (clause) => "number" in clause,
      ),
    );

    assert.deepStrictEqual(numberClauses, [
      { number: { eq: 12 } },
      { number: { eq: 12 } },
      { number: { eq: 12 } },
      undefined,
      undefined,
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("surfaces malformed saved credential storage", () => {
  const { layer } = makeLayer({ credentials: "not-json", response: () => ({}) });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const error = yield* Effect.flip(api.connection);

    assert.strictEqual(error.reason, "failed");
  }).pipe(Effect.provide(layer));
});

it.effect("keeps Linear GraphQL error text out of caller-visible failures", () => {
  const errors = [{ message: "private upstream diagnostic" }];
  const { layer } = makeLayer({
    envToken: "lin_api_test",
    response: () => ({
      data: { viewer: { id: "user-1", name: null, email: null, avatarUrl: null } },
      errors,
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const error = yield* Effect.flip(api.getViewer({}));

    assert.strictEqual(error.operation, "viewer");
    assert.strictEqual(error.reason, "failed");
    assert.notInclude(error.detail, errors[0]!.message);
    assert.deepStrictEqual(error.cause, errors);
  }).pipe(Effect.provide(layer));
});

it.effect("distinguishes GraphQL authentication errors from author and permission errors", () =>
  Effect.gen(function* () {
    for (const [errors, reason] of [
      [[{ message: "Unknown field author" }], "failed"],
      [[{ message: "Authorization denied", extensions: { code: "FORBIDDEN" } }], "failed"],
      [[{ message: "Sign in", extensions: { code: "AUTHENTICATION_ERROR" } }], "unauthenticated"],
      [[{ message: "Authentication required" }], "unauthenticated"],
      [[{ message: "Unknown author" }, { message: "Invalid access token" }], "unauthenticated"],
    ] as const) {
      const { layer } = makeLayer({ envToken: "lin_api_test", response: () => ({ errors }) });
      const error = yield* Effect.gen(function* () {
        const api = yield* LinearApi.LinearApi;
        return yield* api.getViewer({}).pipe(Effect.flip);
      }).pipe(Effect.provide(layer));
      assert.strictEqual(error.reason, reason);
    }
  }),
);

it.effect("probes a new key before appending a second saved account", () => {
  let values: Map<string, Uint8Array>;
  let newKeyProbed = false;
  const test = makeLayer({
    credentials: pool(["user-1", "lin_api_one"]),
    response: (_body, authorization) => {
      if (authorization === "lin_api_two" && !newKeyProbed) {
        assert.deepStrictEqual(
          decodeJson(new TextDecoder().decode(values.get("issue-trackers.linear.credentials"))),
          decodeJson(pool(["user-1", "lin_api_one"])),
        );
        newKeyProbed = true;
      }
      const second = authorization === "lin_api_two";
      return {
        data: {
          viewer: {
            id: second ? "user-2" : "user-1",
            name: second ? "Grace" : "Ada",
            email: second ? "grace@example.com" : "ada@example.com",
          },
          teams: { nodes: [] },
        },
      };
    },
  });
  values = test.values;
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const result = yield* api.connect("lin_api_two");

    assert.deepStrictEqual(
      result.accounts.map(({ credentialId }) => credentialId),
      ["user-1", "user-2"],
    );
    assert.deepStrictEqual(
      decodeJson(new TextDecoder().decode(values.get("issue-trackers.linear.credentials"))),
      decodeJson(pool(["user-1", "lin_api_one"], ["user-2", "lin_api_two"])),
    );
  }).pipe(Effect.provide(test.layer));
});

it.effect("keeps every account from concurrent connects", () => {
  const { layer, values } = makeLayer({
    credentials: pool(["user-1", "lin_api_one"]),
    response: (_body, authorization) => {
      const suffix =
        authorization === "lin_api_two" ? "2" : authorization === "lin_api_three" ? "3" : "1";
      return {
        data: {
          viewer: { id: `user-${suffix}`, name: `User ${suffix}`, email: null },
          teams: { nodes: [] },
        },
      };
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* Effect.all([api.connect("lin_api_two"), api.connect("lin_api_three")], {
      concurrency: "unbounded",
    });

    const saved = decodeJson(
      new TextDecoder().decode(values.get("issue-trackers.linear.credentials")),
    ) as {
      readonly credentials: ReadonlyArray<{ readonly credentialId: string }>;
    };
    assert.deepStrictEqual(saved.credentials.map(({ credentialId }) => credentialId).toSorted(), [
      "user-1",
      "user-2",
      "user-3",
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("replaces a reconnected account without changing account order", () => {
  const { layer, values } = makeLayer({
    credentials: pool(["user-1", "lin_api_old"], ["user-2", "lin_api_two"]),
    response: (_body, authorization) => ({
      data: {
        viewer: {
          id: authorization === "lin_api_two" ? "user-2" : "user-1",
          name: "Account",
          email: null,
        },
        teams: { nodes: [] },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.connect("lin_api_new");

    assert.deepStrictEqual(
      decodeJson(new TextDecoder().decode(values.get("issue-trackers.linear.credentials"))),
      decodeJson(pool(["user-1", "lin_api_new"], ["user-2", "lin_api_two"])),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("does not reread credential storage after disconnect commits", () => {
  const { layer, values } = makeLayer({
    credentials: pool(["user-1", "lin_api_one"]),
    failCredentialReadsAfterWrite: true,
    response: () => ({
      data: {
        viewer: { id: "user-1", name: "Ada", email: null },
        teams: { nodes: [] },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    assert.strictEqual((yield* api.disconnect({ credentialId: "user-1" })).accounts.length, 0);
    assert.deepStrictEqual(
      decodeJson(new TextDecoder().decode(values.get("issue-trackers.linear.credentials"))),
      decodeJson(pool()),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("routes requests through the selected saved account", () => {
  const { layer, requests } = makeLayer({
    credentials: pool(["user-1", "lin_api_one"], ["user-2", "lin_api_two"]),
    response: (_body, authorization) => ({
      data: { viewer: { id: authorization === "lin_api_one" ? "user-1" : "user-2" } },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const getViewer = api.getViewer as unknown as (input: {
      readonly credentialId: string;
    }) => Effect.Effect<LinearApi.LinearUser, LinearApi.LinearApiError>;
    assert.strictEqual((yield* getViewer({ credentialId: "user-1" })).id, "user-1");
    assert.strictEqual((yield* getViewer({ credentialId: "user-2" })).id, "user-2");
    assert.deepStrictEqual(
      requests.map(({ authorization }) => authorization),
      ["lin_api_one", "lin_api_two"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("deletes only the selected saved account", () => {
  const { layer, values } = makeLayer({
    credentials: pool(["user-1", "lin_api_one"], ["user-2", "lin_api_two"]),
    response: () => ({
      data: {
        viewer: { id: "user-2", name: "Grace", email: "grace@example.com" },
        teams: { nodes: [] },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const disconnect = api.disconnect as unknown as (input: {
      readonly credentialId: string;
    }) => Effect.Effect<unknown, LinearApi.LinearApiError>;
    yield* disconnect({ credentialId: "user-1" });

    assert.deepStrictEqual(
      decodeJson(new TextDecoder().decode(values.get("issue-trackers.linear.credentials"))),
      decodeJson(pool(["user-2", "lin_api_two"])),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("loads Linear activity reactions from API arrays", () => {
  const { layer } = makeLayer({
    envToken: "lin_api_test",
    response: (body) => {
      const query = String(body.query);
      if (query.includes("reactions { nodes")) {
        return { errors: [{ message: 'Field "nodes" does not exist on type "Reaction".' }] };
      }
      return {
        data: {
          viewer: { id: "user-1", name: "Ada", email: "ada@example.com" },
          issue: {
            id: "issue-1",
            identifier: "ENG-7",
            number: 7,
            title: "Activity",
            url: "https://linear.app/eng/issue/ENG-7",
            createdAt: "2026-08-17T00:00:00.000Z",
            updatedAt: "2026-08-17T00:00:00.000Z",
            state: { name: "In Progress", type: "started" },
            comments: {
              nodes: [
                {
                  id: "comment-2",
                  body: "Newest",
                  createdAt: "2026-08-18T00:00:00.000Z",
                  reactions: [],
                },
                {
                  id: "comment-1",
                  body: "Looks good",
                  createdAt: "2026-08-17T00:00:00.000Z",
                  reactions: [{ id: "reaction-1", emoji: "👍", user: { id: "user-1" } }],
                },
              ],
              pageInfo: { hasNextPage: false },
            },
            reactions: [{ id: "reaction-2", emoji: "🎉", user: { id: "user-2" } }],
          },
        },
      };
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    assert.deepStrictEqual(yield* api.getActivity({ identifier: "ENG-7" }), {
      viewerId: "user-1",
      comments: [
        {
          id: "comment-1",
          body: "Looks good",
          createdAt: "2026-08-17T00:00:00.000Z",
          reactions: [{ id: "reaction-1", emoji: "👍", user: { id: "user-1" } }],
        },
        {
          id: "comment-2",
          body: "Newest",
          createdAt: "2026-08-18T00:00:00.000Z",
          reactions: [],
        },
      ],
      reactions: [{ id: "reaction-2", emoji: "🎉", user: { id: "user-2" } }],
      commentsTruncated: false,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("creates and removes Linear issue reactions", () => {
  const { layer, requests } = makeLayer({
    envToken: "lin_api_test",
    response: (body) => {
      const query = String(body.query);
      if (query.includes("reactionCreate")) return { data: { reactionCreate: { success: true } } };
      if (query.includes("reactionDelete")) return { data: { reactionDelete: { success: true } } };
      if (query.includes("reactions { nodes")) {
        return { errors: [{ message: 'Field "nodes" does not exist on type "Reaction".' }] };
      }
      return {
        data: {
          viewer: { id: "user-1" },
          issue: {
            reactions: [{ id: "reaction-1", emoji: "👍", user: { id: "user-1" } }],
          },
        },
      };
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.setReaction({ issueId: "ENG-7", emoji: "👍", reacted: true });
    yield* api.setReaction({ issueId: "ENG-7", emoji: "👍", reacted: false });

    assert.deepStrictEqual((requests[0]?.body.variables as { input: unknown }).input, {
      issueId: "ENG-7",
      emoji: "👍",
    });
    assert.deepStrictEqual(requests.at(-1)?.body.variables, { id: "reaction-1" });
  }).pipe(Effect.provide(layer));
});

it.effect("removes Linear comment reactions from API arrays", () => {
  const { layer, requests } = makeLayer({
    envToken: "lin_api_test",
    response: (body) => {
      const query = String(body.query);
      if (query.includes("reactions { nodes")) {
        return { errors: [{ message: 'Field "nodes" does not exist on type "Reaction".' }] };
      }
      if (query.includes("reactionDelete")) return { data: { reactionDelete: { success: true } } };
      return {
        data: {
          viewer: { id: "user-1" },
          comment: {
            reactions: [{ id: "reaction-1", emoji: "👍", user: { id: "user-1" } }],
          },
        },
      };
    },
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.setReaction({
      issueId: "ENG-7",
      commentId: "comment-1",
      emoji: "👍",
      reacted: false,
    });

    assert.deepStrictEqual(requests[0]?.body.variables, { id: "comment-1" });
    assert.deepStrictEqual(requests.at(-1)?.body.variables, { id: "reaction-1" });
  }).pipe(Effect.provide(layer));
});

it.effect(
  "pages through tied Linear updates without loss and reads the oldest slice in ascending order",
  () => {
    const rows = Array.from({ length: 263 }, (_, index) => ({
      id: `issue-${index + 1}`,
      identifier: `ENG-${index + 1}`,
      number: index + 1,
      title: `Issue ${index + 1}`,
      url: `https://linear.app/acme/issue/ENG-${index + 1}`,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: index < 261 ? "2026-07-03T00:00:00.000Z" : `2026-07-0${263 - index}T00:00:00.000Z`,
      state: { name: "Open", type: "started" },
    }));
    const { layer, requests } = makeLayer({
      envToken: "lin_api_test",
      response: (body) => {
        const variables = body.variables as {
          first?: number;
          last?: number;
          after?: string;
          before?: string;
          filter: { updatedAt?: { lte: string }; number?: { nin: number[] } };
        };
        const filtered = rows.filter(
          (row) =>
            (variables.filter.updatedAt === undefined ||
              row.updatedAt <= variables.filter.updatedAt.lte) &&
            !variables.filter.number?.nin.includes(row.number),
        );
        const selected = filtered.slice(
          variables.after === undefined
            ? 0
            : filtered.findIndex((row) => row.id === variables.after) + 1,
          variables.before === undefined
            ? undefined
            : filtered.findIndex((row) => row.id === variables.before),
        );
        const size = variables.first ?? variables.last ?? 50;
        const nodes =
          variables.last === undefined ? selected.slice(0, size) : selected.slice(-size);
        return {
          data: {
            issues: {
              nodes,
              pageInfo: {
                hasNextPage: variables.last === undefined && selected.length > size,
                hasPreviousPage: variables.last !== undefined && selected.length > size,
                startCursor: nodes[0]?.id ?? null,
                endCursor: nodes.at(-1)?.id ?? null,
              },
            },
          },
        };
      },
    });
    return Effect.gen(function* () {
      const provider = yield* LinearIssueProvider.make;
      const input = {
        cwd: "/w",
        repository: "ENG",
        host: "linear.app",
        state: "open",
        involvement: "all",
        viewer: "user-1",
        limit: 10,
      } as const;
      const delivered: number[] = [];
      let cursor: ProviderListCursor | undefined;
      let truncated = true;
      for (let page = 0; page < 28 && truncated; page++) {
        const batch = yield* provider.listIssues({ ...input, cursor });
        delivered.push(...batch.items.map((item) => item.number));
        truncated = batch.truncated;
        const boundary = batch.items.at(-1)?.updatedAt;
        assert.isDefined(boundary);
        cursor = {
          updatedBefore: boundary,
          seenAt: [
            ...(cursor?.updatedBefore === boundary ? (cursor.seenAt ?? []) : []),
            ...batch.items.filter((item) => item.updatedAt === boundary).map((item) => item.number),
          ],
        };
      }
      assert.deepStrictEqual(
        delivered,
        rows.map((row) => row.number),
      );
      assert.isFalse(truncated);
      const oldest = yield* provider.listIssues({ ...input, order: "asc" });
      assert.deepStrictEqual(
        oldest.items.map((item) => item.number),
        [263, 262, 261, 260, 259, 258, 257, 256, 255, 254],
      );
      assert.isTrue(oldest.truncated);
      assert.isFalse(oldest.continues);
      assert.include(String(requests.at(-1)?.body.query), "last: $last");
      const cappedOldest = yield* provider.listIssues({ ...input, limit: 500, order: "asc" });
      assert.strictEqual(cappedOldest.items.length, 263);
      assert.strictEqual(cappedOldest.items[0]?.number, 263);
      assert.isFalse(cappedOldest.truncated);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layer,
          ServerSettings.layerTest({ issueTracking: { connections: { linear: {} } } } as never),
        ),
      ),
    );
  },
);

it.effect.each([true, false])(
  "handles compound Linear endpoint limits with Endpoint-Name present: %s",
  (named) => {
    const { layer, requests } = makeLayer({
      envToken: "environment-key",
      credentials: pool(["saved", "saved-key"]),
      response: (body) => {
        const query = String(body.query);
        if (query.includes("T3LinearIssueActivity"))
          return Response.json(
            {},
            {
              status: 429,
              headers: {
                ...(named ? { "X-RateLimit-Endpoint-Name": "viewer" } : {}),
                "X-RateLimit-Endpoint-Requests-Remaining": "0",
                "X-RateLimit-Endpoint-Requests-Reset": "121000",
              },
            },
          );
        if (query.includes("T3LinearIssueSummary"))
          return {
            data: {
              issue: {
                number: 1,
                title: "Issue",
                url: "https://linear.app/issue/ENG-1",
                state: { name: "Open", type: "started" },
              },
            },
          };
        return { data: { viewer: { id: "user" }, teams: { nodes: [] } } };
      },
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      yield* api.getViewer({});
      yield* api.getViewer({ credentialId: "saved" });
      yield* api.getActivity({ identifier: "ENG-1" }).pipe(Effect.flip);
      assert.equal(
        (yield* api.getViewer({ credentialId: "saved" }).pipe(Effect.flip)).retryAt,
        121000,
      );
      yield* api.connection;
      assert.equal(requests.length, 3);
      if (named) {
        yield* api.getIssueSummary({ identifier: "ENG-1" });
        assert.equal(requests.length, 4);
      } else {
        assert.equal(
          (yield* api.getIssueSummary({ identifier: "ENG-1" }).pipe(Effect.flip)).retryAt,
          121000,
        );
        assert.equal(requests.length, 3);
      }
    }).pipe(Effect.provide(layer));
  },
);

it.effect("keeps Linear reaction creation and deletion endpoint pauses separate", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: (body) => {
      const query = String(body.query);
      if (query.includes("reactionCreate"))
        return Response.json(
          {},
          {
            status: 429,
            headers: {
              "X-RateLimit-Endpoint-Name": "reactionCreate",
              "X-RateLimit-Endpoint-Requests-Remaining": "0",
              "X-RateLimit-Endpoint-Requests-Reset": "121000",
            },
          },
        );
      if (query.includes("reactionDelete")) return { data: { reactionDelete: { success: true } } };
      return {
        data: {
          viewer: { id: "user" },
          issue: { reactions: [{ id: "reaction", emoji: "👍", user: { id: "user" } }] },
        },
      };
    },
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    yield* api.getViewer({});
    yield* api.setReaction({ issueId: "ENG-1", emoji: "👍", reacted: true }).pipe(Effect.flip);
    yield* api.setReaction({ issueId: "ENG-1", emoji: "👍", reacted: false });
    assert.equal(requests.length, 4);
    assert.include(String(requests.at(-1)?.body.query), "reactionDelete");
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  [250, "desc"],
  [198, "asc"],
  [500, "asc"],
] as const)(
  "fetches the complete %s-row %s Linear prefix within the query cost limit",
  ([limit, order]) => {
    const rows = Array.from({ length: 563 }, (_, index) => ({
      id: `issue-${index + 1}`,
      identifier: `ENG-${index + 1}`,
      number: index + 1,
      title: `Issue ${index + 1}`,
      url: `https://linear.app/acme/issue/ENG-${index + 1}`,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
      state: { name: "Open", type: "started" },
      labels: {
        nodes: Array.from({ length: 50 }, (_, label) => ({
          name: `Label ${label + 1}`,
          color: "abcdef",
        })),
      },
    }));
    const { layer, requests } = makeLayer({
      envToken: "test-key",
      response: (body) => {
        const query = String(body.query);
        const variables = body.variables as {
          first?: number;
          last?: number;
          after?: string;
          before?: string;
          filter: { number?: { nin: number[] } };
        };
        const fields = query.match(/nodes \{([\s\S]+)\}\s+pageInfo/)![1]!;
        const labels = fields.match(/labels(?:\(first: (\d+)\))?\s*\{\s*nodes\s*\{([^{}]+)\}/)!;
        const labelCost =
          Number(labels[1] ?? 50) * (1 + labels[2]!.trim().split(/\s+/).length * 0.1);
        const objectCost = [
          ...fields.matchAll(/(?:state|creator|assignee)\s*\{([^{}]+)\}/g),
        ].reduce((cost, match) => cost + 1 + match[1]!.trim().split(/\s+/).length * 0.1, 0);
        const scalarFields = fields
          .replace(/labels(?:\(first: \d+\))?\s*\{\s*nodes\s*\{[^{}]+\}\s*\}/, "")
          .replace(/\w+\s*\{[^{}]+\}/g, "")
          .trim()
          .split(/\s+/);
        const pageFields = query
          .match(/pageInfo\s*\{([^{}]+)\}/)![1]!
          .trim()
          .split(/\s+/);
        const size = variables.first ?? variables.last ?? 50;
        const complexity = Math.ceil(
          size * (1 + scalarFields.length * 0.1 + objectCost + labelCost) +
            1 +
            pageFields.length * 0.1,
        );
        assert.include(query, "labels { nodes { name color } }");
        if (complexity > 10000)
          return { errors: [{ message: "Query exceeds maximum complexity" }] };
        const filtered = rows.filter((row) => !variables.filter.number?.nin.includes(row.number));
        const selected = filtered.slice(
          variables.after === undefined
            ? 0
            : filtered.findIndex((row) => row.id === variables.after) + 1,
          variables.before === undefined
            ? undefined
            : filtered.findIndex((row) => row.id === variables.before),
        );
        const nodes =
          variables.last === undefined ? selected.slice(0, size) : selected.slice(-size);
        return {
          data: {
            issues: {
              nodes,
              pageInfo: {
                hasNextPage: variables.last === undefined && selected.length > size,
                hasPreviousPage: variables.last !== undefined && selected.length > size,
                startCursor: nodes[0]?.id ?? null,
                endCursor: nodes.at(-1)?.id ?? null,
              },
            },
          },
        };
      },
    });
    return Effect.gen(function* () {
      const api = yield* LinearApi.LinearApi;
      const input = {
        teamKey: "ENG",
        state: "all",
        involvement: "all",
        viewer: "user",
        limit,
        order,
      } as const;
      const page = yield* api.listIssues(input);
      const expected = order === "asc" ? rows.toReversed().slice(0, limit) : rows.slice(0, limit);
      assert.lengthOf(page.issues, limit);
      assert.deepStrictEqual(page.issues, expected);
      assert.isTrue(page.truncated);
      assert.isAtMost(requests.length, 4);
      assert.isTrue(
        requests.every(({ body }) => {
          const variables = body.variables as { first?: number; last?: number };
          return (variables.first ?? variables.last ?? 0) <= 150;
        }),
      );
      if (order === "desc") {
        const next = yield* api.listIssues({
          ...input,
          cursor: {
            updatedBefore: page.issues.at(-1)!.updatedAt,
            seenAt: page.issues.map((issue) => issue.number),
          },
        });
        assert.deepStrictEqual(next.issues, rows.slice(limit, limit * 2));
        assert.isTrue(next.truncated);
      }
    }).pipe(Effect.provide(layer));
  },
);

it.effect("checks the complexity balance before fetching another Linear list page", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: () =>
      Response.json(
        {
          data: {
            issues: {
              nodes: Array.from({ length: 150 }, (_, index) => ({
                id: `issue-${index}`,
                identifier: `ENG-${index}`,
                number: index,
                title: "Issue",
                url: "https://linear.app/issue",
                createdAt: "2026-07-01T00:00:00.000Z",
                updatedAt: "2026-07-03T00:00:00.000Z",
                state: { name: "Open", type: "started" },
              })),
              pageInfo: { hasNextPage: true, hasPreviousPage: false, endCursor: "next" },
            },
          },
        },
        {
          headers: {
            "X-RateLimit-Complexity-Remaining": "100",
            "X-RateLimit-Complexity-Reset": "61000",
          },
        },
      ),
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    const error = yield* api
      .listIssues({ teamKey: "ENG", state: "all", involvement: "all", viewer: "user", limit: 198 })
      .pipe(Effect.flip);
    assert.equal(error.retryAt, 61000);
    assert.equal(requests.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect.each(["requests", "complexity"])(
  "keeps the later shared Linear %s reset when a new key is verified",
  (kind) => {
    const { layer, requests } = makeLayer({
      envToken: "known-key",
      credentials: pool(["new", "new-key"]),
      response: (_body, authorization) =>
        Response.json(
          { data: { viewer: { id: "user" } } },
          {
            headers:
              authorization === "new-key"
                ? {
                    "X-RateLimit-Complexity-Remaining": "9999",
                    "X-RateLimit-Complexity-Reset": "61000",
                    "X-RateLimit-Requests-Remaining": "20",
                  }
                : {
                    [`X-RateLimit-${kind}-Remaining`]: kind === "complexity" ? "4000" : "0",
                    [`X-RateLimit-${kind}-Reset`]: "121000",
                  },
          },
        ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      yield* api.getViewer({});
      yield* api.getViewer({ credentialId: "new" });
      for (const credentialId of [undefined, "new"])
        assert.equal(
          (yield* api
            .getIssue({
              identifier: "ENG-1",
              ...(credentialId === undefined ? {} : { credentialId }),
            })
            .pipe(Effect.flip)).retryAt,
          121000,
        );
      assert.equal(requests.length, 2);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("retains an unknown token's endpoint pause when its Linear user is verified", () => {
  const { layer, requests } = makeLayer({
    envToken: "known-key",
    credentials: pool(["new", "new-key"]),
    response: (body) =>
      String(body.query).includes("T3LinearIssues")
        ? Response.json(
            {},
            {
              status: 429,
              headers: {
                "X-RateLimit-Endpoint-Requests-Remaining": "0",
                "X-RateLimit-Endpoint-Requests-Reset": "61000",
              },
            },
          )
        : { data: { viewer: { id: "user" } } },
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    const input = {
      teamKey: "ENG",
      state: "all",
      involvement: "all",
      viewer: "user",
      limit: 5,
    } as const;
    yield* api.getViewer({});
    assert.equal(
      (yield* api.listIssues({ ...input, credentialId: "new" }).pipe(Effect.flip)).retryAt,
      61000,
    );
    yield* api.getViewer({ credentialId: "new" });
    for (const credentialId of [undefined, "new"])
      assert.equal(
        (yield* api
          .listIssues({ ...input, ...(credentialId === undefined ? {} : { credentialId }) })
          .pipe(Effect.flip)).retryAt,
        61000,
      );
    assert.equal(requests.length, 3);
    yield* api.getViewer({});
    assert.equal(requests.length, 4);
  }).pipe(Effect.provide(layer));
});

it.effect.each(["requests", "complexity", "rate-limit", "endpoint", "low-budget"])(
  "shares verified Linear user %s limits across keys without joining different users",
  (kind) => {
    let limited = false;
    const { layer, requests } = makeLayer({
      envToken: "environment-key",
      credentials: pool(["saved", "saved-key"], ["new", "new-key"], ["same-user", "other-key"]),
      response: (body, authorization) => {
        const query = String(body.query);
        if (query.includes("T3LinearIssue(")) return { data: { issue: null } };
        if (query.includes("T3LinearComment"))
          return { data: { commentCreate: { success: true } } };
        const payload = {
          data: { viewer: { id: authorization === "other-key" ? "other-user" : "user" } },
        };
        if (!limited || authorization !== "environment-key") return payload;
        return Response.json(payload, {
          status: kind === "rate-limit" || kind === "endpoint" ? 429 : 200,
          headers:
            kind === "rate-limit"
              ? { "Retry-After": "60" }
              : kind === "low-budget"
                ? {
                    "X-RateLimit-Complexity-Remaining": "4000",
                    "X-RateLimit-Complexity-Reset": "61000",
                  }
                : {
                    [`X-RateLimit-${kind === "endpoint" ? "Endpoint-Requests" : kind}-Remaining`]:
                      "0",
                    [`X-RateLimit-${kind === "endpoint" ? "Endpoint-Requests" : kind}-Reset`]:
                      "61000",
                  },
        });
      },
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      yield* api.getViewer({});
      yield* api.getViewer({ credentialId: "saved" });
      limited = true;
      yield* api.getViewer({}).pipe(Effect.exit);
      for (const credentialId of [undefined, "saved"]) {
        const error = yield* (
          kind === "low-budget"
            ? api.getIssue({
                identifier: "ENG-1",
                ...(credentialId === undefined ? {} : { credentialId }),
              })
            : api.getViewer(credentialId === undefined ? {} : { credentialId })
        ).pipe(Effect.flip);
        assert.equal(error.reason, "rate-limited");
        assert.equal(error.retryAt, 61000);
        if (kind === "low-budget")
          assert.equal(
            (yield* api
              .listIssues({
                teamKey: "ENG",
                state: "all",
                involvement: "all",
                viewer: "user",
                limit: 198,
                ...(credentialId === undefined ? {} : { credentialId }),
              })
              .pipe(Effect.flip)).reason,
            "rate-limited",
          );
      }
      assert.equal(requests.length, 3);
      yield* api.getViewer({ credentialId: "new" });
      assert.equal(requests.length, 4);
      assert.equal(
        (yield* (
          kind === "low-budget"
            ? api.getIssue({ identifier: "ENG-1", credentialId: "new" })
            : api.getViewer({ credentialId: "new" })
        ).pipe(Effect.flip)).retryAt,
        61000,
      );
      assert.equal(requests.length, 4);
      yield* api.getViewer({ credentialId: "same-user" });
      assert.equal(
        (yield* api.getIssue({ identifier: "ENG-1", credentialId: "same-user" }).pipe(Effect.flip))
          .reason,
        "failed",
      );
      assert.equal(requests.length, 6);
      if (kind === "endpoint") {
        yield* api.comment({ issueId: "ENG-1", body: "Hello", credentialId: "saved" });
        assert.equal(requests.length, 7);
      }
      limited = false;
      yield* TestClock.setTime(61000);
      yield* api.getViewer({});
      yield* api.getViewer({ credentialId: "saved" });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("does not accept a Linear viewer identity from a failed response", () => {
  let limited = false;
  let failed = true;
  const { layer, requests } = makeLayer({
    envToken: "known-key",
    credentials: pool(["same-user", "unknown-key"]),
    response: (_, authorization) => {
      if (authorization === "unknown-key")
        return {
          data: { viewer: { id: "user" } },
          ...(failed ? { errors: [{ message: "Permission denied" }] } : {}),
        };
      return limited
        ? Response.json({}, { status: 429, headers: { "Retry-After": "60" } })
        : { data: { viewer: { id: "user" } } };
    },
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    yield* api.getViewer({});
    assert.equal(
      (yield* api.getViewer({ credentialId: "same-user" }).pipe(Effect.flip)).reason,
      "failed",
    );
    limited = true;
    yield* api.getViewer({}).pipe(Effect.flip);
    failed = false;
    yield* api.getViewer({ credentialId: "same-user" });
    assert.equal(requests.length, 4);
    assert.equal(
      (yield* api.getViewer({ credentialId: "same-user" }).pipe(Effect.flip)).reason,
      "rate-limited",
    );
    assert.equal(requests.length, 4);
  }).pipe(Effect.provide(layer));
});

it.effect("shares Linear pauses across requests, isolates tokens, and resumes at the reset", () => {
  let limited = true;
  const { layer, requests } = makeLayer({
    envToken: "environment-key",
    credentials: pool(["other", "other-key"]),
    response: (_, authorization) =>
      authorization === "environment-key" && limited
        ? Response.json({}, { status: 429, headers: { "Retry-After": "60" } })
        : { data: { viewer: { id: "user" } } },
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    const first = yield* api.getViewer({}).pipe(Effect.flip);
    assert.equal(first.reason, "rate-limited");
    assert.equal(first.retryAt, 61000);
    assert.equal((yield* api.getViewer({}).pipe(Effect.flip)).retryAt, 61000);
    assert.equal(requests.length, 1);
    yield* api.getViewer({ credentialId: "other" });
    assert.equal(requests.length, 2);
    limited = false;
    yield* TestClock.adjust("1 minute");
    yield* api.getViewer({});
    assert.equal(requests.length, 3);
  }).pipe(Effect.provide(layer));
});

it.effect.each([400, 200])(
  "recognizes Linear RATELIMITED errors at HTTP %s without retrying the host",
  (status) => {
    const { layer, requests } = makeLayer({
      envToken: "test-key",
      response: () =>
        Response.json(
          { errors: [{ message: "Too many requests", extensions: { code: "RATELIMITED" } }] },
          {
            status,
            headers: {
              "X-RateLimit-Complexity-Remaining": "0",
              "X-RateLimit-Complexity-Reset": "121000",
            },
          },
        ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      assert.equal((yield* api.getViewer({}).pipe(Effect.flip)).retryAt, 121000);
      assert.equal((yield* api.getViewer({}).pipe(Effect.flip)).reason, "rate-limited");
      assert.equal(requests.length, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "keeps a successful Linear response and pauses further calls when its budget is empty",
  () => {
    const { layer, requests } = makeLayer({
      envToken: "test-key",
      response: () =>
        Response.json(
          { data: { viewer: { id: "user" } } },
          {
            headers: {
              "X-RateLimit-Requests-Remaining": "0",
              "X-RateLimit-Requests-Reset": "61000",
            },
          },
        ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      assert.equal((yield* api.getViewer({})).id, "user");
      assert.equal((yield* api.getViewer({}).pipe(Effect.flip)).retryAt, 61000);
      assert.equal(requests.length, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "blocks details with a positive low balance while allowing cheap calls and other tokens",
  () => {
    const { layer, requests } = makeLayer({
      envToken: "environment-key",
      credentials: pool(["other", "other-key"]),
      response: (body) => {
        const query = String(body.query);
        if (query.includes("T3LinearIssue(")) return { data: { issue: null } };
        if (query.includes("T3LinearComment"))
          return { data: { commentCreate: { success: true } } };
        return Response.json(
          { data: { viewer: { id: "user" } } },
          {
            headers: {
              "X-Complexity": "2",
              "X-RateLimit-Complexity-Remaining": "4000",
              "X-RateLimit-Complexity-Reset": "61000",
            },
          },
        );
      },
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      yield* api.getViewer({});
      const error = yield* Effect.flip(api.getIssue({ identifier: "ENG-1" }));
      assert.equal(error.reason, "rate-limited");
      assert.equal(error.retryAt, 61000);
      assert.equal(requests.length, 1);
      assert.equal((yield* api.getViewer({})).id, "user");
      yield* api.comment({ issueId: "issue-1", body: "Hello" });
      assert.equal(requests.length, 3);
      assert.equal(
        (yield* Effect.flip(api.getIssue({ identifier: "ENG-1", credentialId: "other" }))).reason,
        "failed",
      );
      assert.equal(requests.length, 4);
      yield* TestClock.setTime(61000);
      assert.equal((yield* Effect.flip(api.getIssue({ identifier: "ENG-2" }))).reason, "failed");
      assert.equal(requests.length, 5);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("stops queued distinct detail reads after the first low-budget response", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: () =>
      Response.json(
        { data: { issue: null } },
        {
          headers: {
            "X-RateLimit-Complexity-Remaining": "4000",
            "X-RateLimit-Complexity-Reset": "61000",
          },
        },
      ),
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    const errors = yield* Effect.all(
      Array.from({ length: 20 }, (_, index) =>
        Effect.flip(api.getIssue({ identifier: `ENG-${index + 1}` })),
      ),
      { concurrency: "unbounded" },
    );
    assert.equal(requests.length, 1);
    assert.equal(errors.filter((error) => error.reason === "failed").length, 1);
    assert.equal(errors.filter((error) => error.reason === "rate-limited").length, 19);
    assert.ok(
      errors
        .filter((error) => error.reason === "rate-limited")
        .every((error) => error.retryAt === 61000),
    );
  }).pipe(Effect.provide(layer));
});

it.effect.each([200, 500])(
  "deducts detail cost without headers even on HTTP %s failure",
  (status) => {
    const { layer, requests } = makeLayer({
      envToken: "test-key",
      response: (body) => {
        if (String(body.query).includes("T3LinearIssue("))
          return Response.json({ data: { issue: null } }, { status });
        return requests.length === 1
          ? Response.json(
              { data: { viewer: { id: "user" } } },
              {
                headers: {
                  "X-Complexity": "2",
                  "X-RateLimit-Complexity-Remaining": "9000",
                  "X-RateLimit-Complexity-Reset": "61000",
                },
              },
            )
          : { data: { viewer: { id: "user" } } };
      },
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      yield* api.getViewer({});
      assert.equal((yield* Effect.flip(api.getIssue({ identifier: "ENG-1" }))).reason, "failed");
      assert.equal(
        (yield* Effect.flip(api.getIssue({ identifier: "ENG-2" }))).reason,
        "rate-limited",
      );
      assert.equal(requests.length, 2);
      yield* api.getViewer({});
      assert.equal(
        (yield* Effect.flip(api.getIssue({ identifier: "ENG-3" }))).reason,
        "rate-limited",
      );
      assert.equal(requests.length, 3);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("uses observed document costs and refreshes positive balances", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: (body) => {
      const query = String(body.query);
      if (query.includes("T3LinearIssue(")) return { data: { issue: null } };
      if (query.includes("T3LinearViewer"))
        return requests.length === 1
          ? Response.json(
              { data: { viewer: { id: "user" } } },
              {
                headers: {
                  "X-Complexity": "7",
                  "X-RateLimit-Complexity-Remaining": "6",
                  "X-RateLimit-Complexity-Reset": "61000",
                },
              },
            )
          : { data: { viewer: { id: "user" } } };
      return Response.json(
        { data: { commentCreate: { success: true } } },
        {
          headers: {
            "X-Complexity": "1",
            ...(requests.length === 2
              ? {}
              : {
                  "X-RateLimit-Complexity-Remaining": "5500",
                  "X-RateLimit-Complexity-Reset": "121000",
                }),
          },
        },
      );
    },
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    yield* api.getViewer({});
    assert.equal((yield* Effect.flip(api.getViewer({}))).retryAt, 61000);
    assert.equal(requests.length, 1);
    yield* api.comment({ issueId: "issue-1", body: "Hello" });
    yield* api.comment({ issueId: "issue-1", body: "Again" });
    assert.equal((yield* Effect.flip(api.getIssue({ identifier: "ENG-1" }))).reason, "failed");
    assert.equal((yield* Effect.flip(api.getIssue({ identifier: "ENG-2" }))).retryAt, 121000);
    yield* api.getViewer({});
    assert.equal(requests.length, 5);
  }).pipe(Effect.provide(layer));
});

it.effect("reads a Linear issue summary without its body, labels, or comments", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: () => ({
      data: {
        issue: {
          number: 7,
          title: "Bug",
          url: "https://linear.app/test/issue/DEV-7",
          state: { name: "Done", type: "completed" },
        },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    assert.equal((yield* api.getIssueSummary({ identifier: "DEV-7" })).number, 7);
    assert.equal(requests.length, 1);
    const query = String(requests[0]?.body.query);
    assert.ok(query.includes("number title url state"));
    assert.ok(!/description|labels|comments|viewer/.test(query));
  }).pipe(Effect.provide(layer));
});

it.effect("keeps the three-level Linear detail query below the complexity limit", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: () => ({ data: { issue: null } }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* Effect.flip(api.getIssue({ identifier: "ENG-1" }));
    const query = String(requests[0]?.body.query);
    assert.include(query, "attachments(first: 50)");
    const childLimits = [...query.matchAll(/children\(first: (\d+)\)/g)].map((match) =>
      Number(match[1]),
    );
    assert.lengthOf(childLimits, 3);
    const attachmentLimits = [...query.matchAll(/attachments(?:\(first: (\d+)\))?/g)].map((match) =>
      Number(match[1] ?? 50),
    );
    assert.lengthOf(attachmentLimits, 3);
    const [children, grandchildren, greatGrandchildren] = childLimits;
    const [issueAttachments, parentAttachments, childAttachments] = attachmentLimits;
    const attachmentCost = 1 + 4 * 0.1;
    const relativeCost = 1 + 3 * 0.1 + (1 + 0.1) + (1 + 2 * 0.1);
    const issueCost = 1 + 10 * 0.1 + (1 + 2 * 0.1) + 2 * (1 + 4 * 0.1) + 50 * (1 + 2 * 0.1);
    const complexity = Math.ceil(
      issueCost +
        issueAttachments! * attachmentCost +
        3 * relativeCost +
        parentAttachments! * attachmentCost +
        children! *
          (relativeCost +
            childAttachments! * attachmentCost +
            grandchildren! * (relativeCost + greatGrandchildren! * relativeCost)),
    );
    assert.isBelow(complexity, 5_000);
  }).pipe(Effect.provide(layer));
});

it.effect("queries and decodes team keys on Linear issue relatives", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: () => ({
      data: {
        issue: {
          id: "issue-1",
          identifier: "ENG-1",
          number: 1,
          title: "Epic",
          url: "https://linear.app/acme/issue/ENG-1",
          createdAt: "2026-08-17T00:00:00.000Z",
          updatedAt: "2026-08-17T00:00:00.000Z",
          state: { name: "Todo", type: "unstarted" },
          parent: {
            number: 7,
            title: "Initiative",
            url: "https://linear.app/acme/issue/OPS-7",
            team: { key: "OPS" },
            state: { name: "Todo", type: "unstarted" },
          },
          children: {
            nodes: [
              {
                number: 42,
                title: "Engineering part",
                url: "https://linear.app/acme/issue/ENG-42",
                team: { key: "ENG" },
                state: { name: "Todo", type: "unstarted" },
              },
              {
                number: 42,
                title: "Operations part",
                url: "https://linear.app/acme/issue/OPS-42",
                team: { key: "OPS" },
                state: { name: "Todo", type: "unstarted" },
              },
            ],
          },
        },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    const issue = yield* api.getIssue({ identifier: "ENG-1" });
    assert.deepStrictEqual(issue.parent?.team, { key: "OPS" });
    assert.deepStrictEqual(
      issue.children?.nodes.map((child) => [child.team.key, child.number]),
      [
        ["ENG", 42],
        ["OPS", 42],
      ],
    );
    assert.include(String(requests[0]?.body.query), "team { key }");
  }).pipe(Effect.provide(layer));
});

it.effect(
  "shares the native Linear issue endpoint across detail, summary, activity, and reaction reads",
  () => {
    const { layer, requests } = makeLayer({
      envToken: "environment-key",
      credentials: pool(["saved", "saved-key"]),
      response: (body) =>
        String(body.query).includes("T3LinearViewer")
          ? { data: { viewer: { id: "user" } } }
          : Response.json(
              {},
              {
                status: 429,
                headers: {
                  "X-RateLimit-Endpoint-Name": "issue",
                  "X-RateLimit-Endpoint-Requests-Remaining": "0",
                  "X-RateLimit-Endpoint-Requests-Reset": "121000",
                },
              },
            ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      yield* api.getViewer({});
      yield* api.getViewer({ credentialId: "saved" });
      yield* api.getIssue({ identifier: "ENG-1" }).pipe(Effect.flip);
      const account = { credentialId: "saved" };
      for (const [read, operation] of [
        [api.getIssueSummary({ identifier: "ENG-1", ...account }), "issue summary"],
        [api.getActivity({ identifier: "ENG-1", ...account }), "issue activity"],
        [
          api.setReaction({ issueId: "ENG-1", emoji: "👍", reacted: false, ...account }),
          "reaction lookup",
        ],
      ] as const) {
        const error = yield* read.pipe(Effect.flip);
        assert.equal(error.retryAt, 121000);
        assert.equal(error.operation, operation);
      }
      assert.equal(requests.length, 3);
      yield* api.getViewer(account);
      assert.equal(requests.length, 4);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  [429, "requests"],
  [400, "requests"],
  [200, "requests"],
  [429, "complexity"],
  [400, "complexity"],
  [200, "complexity"],
] as const)(
  "keeps separate global and endpoint resets for HTTP %s %s exhaustion",
  ([status, kind]) => {
    const { layer, requests } = makeLayer({
      envToken: "environment-key",
      credentials: pool(["saved", "saved-key"]),
      response: (body) =>
        String(body.query).includes("T3LinearViewer")
          ? { data: { viewer: { id: "user" } } }
          : Response.json(
              { errors: [{ message: "Too many requests", extensions: { code: "RATELIMITED" } }] },
              {
                status,
                headers: {
                  [`X-RateLimit-${kind}-Remaining`]: "0",
                  [`X-RateLimit-${kind}-Reset`]: "61000",
                  "X-RateLimit-Endpoint-Name": "issue",
                  "X-RateLimit-Endpoint-Requests-Remaining": "0",
                  "X-RateLimit-Endpoint-Requests-Reset": "121000",
                },
              },
            ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      yield* api.getViewer({});
      yield* api.getViewer({ credentialId: "saved" });
      yield* api.getIssue({ identifier: "ENG-1" }).pipe(Effect.flip);
      assert.equal(
        (yield* api.getViewer({ credentialId: "saved" }).pipe(Effect.flip)).retryAt,
        61000,
      );
      assert.equal(requests.length, 3);
      yield* TestClock.setTime(61000);
      yield* api.getViewer({ credentialId: "saved" });
      assert.equal(requests.length, 4);
      for (const account of [{}, { credentialId: "saved" }] as const) {
        const error = yield* api.getIssue({ identifier: "ENG-1", ...account }).pipe(Effect.flip);
        assert.equal(error.retryAt, 121000);
      }
      assert.equal(requests.length, 4);
      yield* TestClock.setTime(121000);
      yield* api.getIssue({ identifier: "ENG-1" }).pipe(Effect.flip);
      assert.equal(requests.length, 5);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "keeps a later Retry-After on the affected Linear endpoint after the global reset",
  () => {
    const { layer, requests } = makeLayer({
      envToken: "environment-key",
      credentials: pool(["saved", "saved-key"]),
      response: (body) =>
        String(body.query).includes("T3LinearViewer")
          ? { data: { viewer: { id: "user" } } }
          : Response.json(
              {},
              {
                status: 429,
                headers: {
                  "Retry-After": "180",
                  "X-RateLimit-Requests-Remaining": "0",
                  "X-RateLimit-Requests-Reset": "61000",
                  "X-RateLimit-Endpoint-Name": "issue",
                  "X-RateLimit-Endpoint-Requests-Remaining": "0",
                  "X-RateLimit-Endpoint-Requests-Reset": "121000",
                },
              },
            ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const api = yield* LinearApi.LinearApi;
      yield* api.getViewer({});
      yield* api.getViewer({ credentialId: "saved" });
      assert.equal(
        (yield* api.getIssue({ identifier: "ENG-1" }).pipe(Effect.flip)).retryAt,
        181000,
      );
      assert.equal((yield* api.getViewer({}).pipe(Effect.flip)).retryAt, 61000);
      yield* TestClock.setTime(61000);
      yield* api.getViewer({});
      yield* TestClock.setTime(121000);
      assert.equal(
        (yield* api.getIssue({ identifier: "ENG-1", credentialId: "saved" }).pipe(Effect.flip))
          .retryAt,
        181000,
      );
      assert.equal(requests.length, 4);
      yield* api.getViewer({ credentialId: "saved" });
      assert.equal(requests.length, 5);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("an endpoint pause does not block other Linear operations", () => {
  const { layer, requests } = makeLayer({
    envToken: "test-key",
    response: (body) =>
      String(body.query).includes("T3LinearViewer")
        ? Response.json(
            {},
            {
              status: 429,
              headers: {
                "X-RateLimit-Endpoint-Requests-Remaining": "0",
                "X-RateLimit-Endpoint-Requests-Reset": "61000",
              },
            },
          )
        : {
            data: {
              issue: {
                number: 7,
                title: "Bug",
                url: "https://linear.app/test/issue/DEV-7",
                state: { name: "Done", type: "completed" },
              },
            },
          },
  });
  return Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const api = yield* LinearApi.LinearApi;
    yield* api.getViewer({}).pipe(Effect.flip);
    yield* api.getViewer({}).pipe(Effect.flip);
    assert.equal(requests.length, 1);
    yield* api.getIssueSummary({ identifier: "DEV-7" });
    assert.equal(requests.length, 2);
  }).pipe(Effect.provide(layer));
});
