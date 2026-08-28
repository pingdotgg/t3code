import { assert, it, vi } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as LinearApi from "./LinearApi.ts";

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
    readonly legacyRemoveFailures?: number;
  } = {},
) {
  const values = new Map<string, Uint8Array>();
  let credentialsWritten = false;
  let legacyRemoveFailures = options.legacyRemoveFailures ?? 0;
  let legacyRemoveAttempts = 0;
  for (const [name, value] of Object.entries(initial)) values.set(name, bytes(value));
  const service = ServerSecretStore.ServerSecretStore.of({
    get: (name) => {
      if (
        name === "linear.credentials" &&
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
        if (name === "linear.credentials") credentialsWritten = true;
        values.set(name, value);
      }),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: (name, size) =>
      Effect.sync(() => {
        const value = values.get(name) ?? new Uint8Array(size);
        values.set(name, value);
        return value;
      }),
    remove: (name) =>
      Effect.suspend(() => {
        if (name === LinearApi.LINEAR_API_TOKEN_SECRET) {
          legacyRemoveAttempts += 1;
          if (legacyRemoveFailures > 0) {
            legacyRemoveFailures -= 1;
            return Effect.fail(
              new ServerSecretStore.SecretStoreRemoveError({ resource: name, cause: "test" }),
            );
          }
        }
        return Effect.sync(() => void values.delete(name));
      }),
  });
  return { service, values, legacyRemoveAttempts: () => legacyRemoveAttempts };
}

function makeLayer(input: {
  readonly token?: string;
  readonly envToken?: string;
  readonly credentials?: string;
  readonly failCredentialReadsAfterWrite?: boolean;
  readonly legacyRemoveFailures?: number;
  readonly response: (body: Record<string, unknown>, authorization: string | undefined) => unknown;
}) {
  const requests: Array<{ body: Record<string, unknown>; authorization: string | undefined }> = [];
  const secrets = memorySecrets(
    {
      ...(input.token === undefined ? {} : { [LinearApi.LINEAR_API_TOKEN_SECRET]: input.token }),
      ...(input.credentials === undefined ? {} : { "linear.credentials": input.credentials }),
    },
    {
      ...(input.failCredentialReadsAfterWrite === undefined
        ? {}
        : { failCredentialReadsAfterWrite: input.failCredentialReadsAfterWrite }),
      ...(input.legacyRemoveFailures === undefined
        ? {}
        : { legacyRemoveFailures: input.legacyRemoveFailures }),
    },
  );
  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
    const raw = (request.body as { readonly body?: Uint8Array }).body;
    const body = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    const authorization = request.headers.authorization;
    requests.push({ body, authorization });
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json(input.response(body, authorization))),
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
    legacyRemoveAttempts: secrets.legacyRemoveAttempts,
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
      teams: [],
      accounts: [],
    });
    assert.strictEqual(response.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("uses the environment token for unbound legacy teams beside saved accounts", () => {
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

it.effect("keeps unbound legacy teams on the saved token until migration completes", () => {
  const { layer, requests } = makeLayer({
    token: "lin_api_legacy",
    envToken: "lin_api_env",
    response: () => ({ data: { viewer: { id: "viewer" } } }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    yield* api.getViewer({});

    assert.deepStrictEqual(
      requests.map(({ authorization }) => authorization),
      ["lin_api_legacy"],
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

    assert.strictEqual(connection.accounts[0]?.teams[0]?.key, "SAVED");
    assert.strictEqual(connection.environmentAccount?.teams[0]?.key, "ENV");
    assert.strictEqual(connection.teams[0]?.key, "ENV");
  }).pipe(Effect.provide(layer));
});

it.effect("keeps Linear list continuation when the API page cap is reached", () => {
  const { layer } = makeLayer({
    token: "lin_api_test",
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
          pageInfo: { hasNextPage: true },
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
    token: "lin_api_test",
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

it.effect("reports an invalid legacy key as stored so old clients can disconnect it", () => {
  const { layer } = makeLayer({
    token: "lin_api_invalid",
    response: () => ({ data: { viewer: null, teams: { nodes: [] } } }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    assert.deepStrictEqual(yield* api.connection, {
      status: "unauthenticated",
      hasStoredToken: true,
      accountName: null,
      accountEmail: null,
      teams: [],
      accounts: [],
    });
  }).pipe(Effect.provide(layer));
});

it.effect("migrates the legacy token after it has been verified", () => {
  const { layer, values } = makeLayer({
    token: "lin_api_test",
    response: () => ({
      data: {
        viewer: { id: "user-1", name: "Ada", email: "ada@example.com" },
        teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }] },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    assert.deepStrictEqual(yield* api.connection, {
      status: "authenticated",
      hasStoredToken: true,
      accountName: "Ada",
      accountEmail: "ada@example.com",
      teams: [{ id: "team-1", key: "ENG", name: "Engineering" }],
      accounts: [
        {
          credentialId: "user-1",
          status: "authenticated",
          accountName: "Ada",
          accountEmail: "ada@example.com",
          teams: [{ id: "team-1", key: "ENG", name: "Engineering" }],
        },
      ],
      migratedCredentialId: "user-1",
    });
    assert.deepStrictEqual(
      decodeJson(new TextDecoder().decode(values.get("linear.credentials"))),
      decodeJson(pool(["user-1", "lin_api_test"])),
    );
    assert.strictEqual(values.has(LinearApi.LINEAR_API_TOKEN_SECRET), true);
    yield* api.completeLegacyMigration;
    assert.strictEqual(values.has(LinearApi.LINEAR_API_TOKEN_SECRET), false);
  }).pipe(Effect.provide(layer));
});

it.effect("probes a new key before appending a second saved account", () => {
  let values: Map<string, Uint8Array>;
  let newKeyProbed = false;
  const test = makeLayer({
    credentials: pool(["user-1", "lin_api_one"]),
    response: (_body, authorization) => {
      if (authorization === "lin_api_two" && !newKeyProbed) {
        assert.deepStrictEqual(
          decodeJson(new TextDecoder().decode(values.get("linear.credentials"))),
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

    assert.strictEqual(result.connectedCredentialId, "user-2");
    assert.deepStrictEqual(
      result.accounts.map(({ credentialId }) => credentialId),
      ["user-1", "user-2"],
    );
    assert.deepStrictEqual(
      decodeJson(new TextDecoder().decode(values.get("linear.credentials"))),
      decodeJson(pool(["user-1", "lin_api_one"], ["user-2", "lin_api_two"])),
    );
  }).pipe(Effect.provide(test.layer));
});

it.effect("replaces an invalid legacy key with a valid submitted key", () => {
  const { layer, values, requests } = makeLayer({
    token: "lin_api_legacy",
    response: (_body, authorization) => ({
      data: {
        viewer:
          authorization === "lin_api_legacy" ? null : { id: "user-2", name: "Grace", email: null },
        teams: { nodes: [] },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;

    const result = yield* api.connect("lin_api_two");

    assert.strictEqual(result.connectedCredentialId, "user-2");
    assert.strictEqual(values.has(LinearApi.LINEAR_API_TOKEN_SECRET), false);
    assert.deepStrictEqual(
      decodeJson(new TextDecoder().decode(values.get(LinearApi.LINEAR_CREDENTIALS_SECRET))),
      decodeJson(pool(["user-2", "lin_api_two"])),
    );
    assert.include(
      requests.map(({ authorization }) => authorization),
      "lin_api_two",
    );
  }).pipe(Effect.provide(layer));
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

    const saved = decodeJson(new TextDecoder().decode(values.get("linear.credentials"))) as {
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
      decodeJson(new TextDecoder().decode(values.get("linear.credentials"))),
      decodeJson(pool(["user-1", "lin_api_new"], ["user-2", "lin_api_two"])),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("keeps a migrated pool until legacy cleanup succeeds", () => {
  const { layer, values, legacyRemoveAttempts } = makeLayer({
    token: "lin_api_test",
    legacyRemoveFailures: 1,
    response: () => ({
      data: {
        viewer: { id: "user-1", name: "Ada", email: "ada@example.com" },
        teams: { nodes: [] },
      },
    }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;

    assert.deepStrictEqual(
      (yield* api.connection).accounts.map(({ credentialId }) => credentialId),
      ["user-1"],
    );
    assert.strictEqual(values.has(LinearApi.LINEAR_API_TOKEN_SECRET), true);

    yield* Effect.flip(api.completeLegacyMigration);
    assert.strictEqual(values.has(LinearApi.LINEAR_API_TOKEN_SECRET), true);
    yield* api.completeLegacyMigration;
    assert.strictEqual(legacyRemoveAttempts(), 2);
    assert.strictEqual(values.has(LinearApi.LINEAR_API_TOKEN_SECRET), false);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "keeps a migrated credential recoverable when disconnect cannot remove its legacy copy",
  () => {
    const { layer, values } = makeLayer({
      token: "lin_api_one",
      credentials: pool(["user-1", "lin_api_one"]),
      legacyRemoveFailures: 1,
      response: () => ({
        data: {
          viewer: { id: "user-1", name: "Ada", email: null },
          teams: { nodes: [] },
        },
      }),
    });
    return Effect.gen(function* () {
      const api = yield* LinearApi.LinearApi;

      yield* Effect.flip(api.disconnect({ credentialId: "user-1" }));
      assert.deepStrictEqual(
        decodeJson(new TextDecoder().decode(values.get("linear.credentials"))),
        decodeJson(pool(["user-1", "lin_api_one"])),
      );

      assert.strictEqual((yield* api.disconnect({ credentialId: "user-1" })).accounts.length, 0);
      assert.strictEqual(values.has(LinearApi.LINEAR_API_TOKEN_SECRET), false);
    }).pipe(Effect.provide(layer));
  },
);

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
      decodeJson(new TextDecoder().decode(values.get("linear.credentials"))),
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
      decodeJson(new TextDecoder().decode(values.get("linear.credentials"))),
      decodeJson(pool(["user-2", "lin_api_two"])),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("disconnects a lone legacy key even when it cannot be verified", () => {
  const { layer, values } = makeLayer({
    token: "lin_api_invalid",
    response: () => ({ data: { viewer: null, teams: { nodes: [] } } }),
  });
  return Effect.gen(function* () {
    const api = yield* LinearApi.LinearApi;
    assert.deepStrictEqual((yield* api.connection).accounts, []);

    yield* api.disconnect(undefined);

    assert.strictEqual(values.has(LinearApi.LINEAR_API_TOKEN_SECRET), false);
  }).pipe(Effect.provide(layer));
});

it.effect("loads Linear activity reactions from API arrays", () => {
  const { layer } = makeLayer({
    token: "lin_api_test",
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
    token: "lin_api_test",
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
    token: "lin_api_test",
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
