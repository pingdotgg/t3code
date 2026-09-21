import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type ProjectId, ServerSettingsError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as LinearApi from "./LinearApi.ts";
import {
  clearCredentialBindings,
  connectLinearAccount,
  disconnectLinearAccount,
  linearConnectionStatus,
  setLinearProjectBinding,
} from "./LinearConnection.ts";

const account = (credentialId: string) => ({
  credentialId,
  status: "authenticated" as const,
  accountName: credentialId,
  accountEmail: null,
  projects: [],
});
const PROJECT_ID = "project_1" as ProjectId;

const connection = (...credentialIds: ReadonlyArray<string>) => ({
  status: credentialIds.length === 0 ? ("unauthenticated" as const) : ("authenticated" as const),
  hasStoredToken: credentialIds.length > 0,
  accountName: credentialIds[0] ?? null,
  accountEmail: null,
  projects: [],
  accounts: credentialIds.map(account),
});

it.effect("reads status without acquiring settings or changing bindings", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* linearConnectionStatus, connection("user-1"));
  }).pipe(
    Effect.provide(
      Layer.mock(LinearApi.LinearApi)({
        connection: Effect.succeed(connection("user-1")),
      }),
    ),
  ),
);

it.effect("adds an account without remapping existing projects", () =>
  Effect.gen(function* () {
    const result = yield* connectLinearAccount("new-token");
    assert.deepStrictEqual(
      result.accounts.map(({ credentialId }) => credentialId),
      ["user-1", "user-2"],
    );
  }).pipe(
    Effect.provide(
      Layer.mock(LinearApi.LinearApi)({
        connect: (token) => {
          assert.strictEqual(token, "new-token");
          return Effect.succeed({
            ...connection("user-1", "user-2"),
          });
        },
      }),
    ),
  ),
);

it("emits tombstones only for bindings owned by the disconnected account", () => {
  assert.deepStrictEqual(
    clearCredentialBindings(
      {
        project_1: { credentialId: "user-1", repository: "ENG" },
        project_2: { credentialId: "user-2", repository: "OPS" },
        project_3: { credentialId: "user-1", repository: "MOBILE" },
      },
      "user-1",
    ),
    { project_1: null, project_3: null },
  );
});

it.effect("rejects project bindings outside the selected saved account", () => {
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed({
      ...connection("user-1"),
      accounts: [
        {
          ...account("user-1"),
          projects: [{ id: "team-1", key: "ENG", name: "Engineering" }],
        },
      ],
    }),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    const invalidCredential = yield* Effect.flip(
      setLinearProjectBinding({
        projectId: PROJECT_ID,
        binding: { credentialId: "user-2", repository: "ENG" },
      }),
    );
    const invalidTeam = yield* Effect.flip(
      setLinearProjectBinding({
        projectId: PROJECT_ID,
        binding: { credentialId: "user-1", repository: "OPS" },
      }),
    );
    const unavailableAccount = yield* Effect.flip(
      setLinearProjectBinding({
        projectId: PROJECT_ID,
        binding: { credentialId: "user-3", repository: "ENG" },
      }).pipe(
        Effect.provideService(
          LinearApi.LinearApi,
          LinearApi.LinearApi.of({
            connection: Effect.succeed({
              ...connection("user-3"),
              accounts: [
                {
                  ...account("user-3"),
                  status: "unverified",
                  projects: [{ id: "team-1", key: "ENG", name: "Engineering" }],
                },
              ],
            }),
          } as unknown as LinearApi.LinearApi["Service"]),
        ),
      ),
    );
    const unavailableEnvironment = yield* Effect.flip(
      setLinearProjectBinding({
        projectId: PROJECT_ID,
        binding: { repository: "ENV" },
      }),
    );
    assert.ok(LinearApi.isLinearApiError(invalidCredential));
    assert.ok(LinearApi.isLinearApiError(invalidTeam));
    assert.ok(LinearApi.isLinearApiError(unavailableAccount));
    assert.ok(LinearApi.isLinearApiError(unavailableEnvironment));
    assert.deepStrictEqual(
      [invalidCredential, invalidTeam, unavailableAccount, unavailableEnvironment].map((error) => ({
        projectId: error.projectId,
        credentialId: error.credentialId,
        repository: error.teamKey,
        bindingRejection: error.bindingRejection,
      })),
      [
        {
          projectId: PROJECT_ID,
          credentialId: "user-2",
          repository: "ENG",
          bindingRejection: "unknown-credential",
        },
        {
          projectId: PROJECT_ID,
          credentialId: "user-1",
          repository: "OPS",
          bindingRejection: "team-unavailable",
        },
        {
          projectId: PROJECT_ID,
          credentialId: "user-3",
          repository: "ENG",
          bindingRejection: "account-unavailable",
        },
        {
          projectId: PROJECT_ID,
          credentialId: undefined,
          repository: "ENV",
          bindingRejection: "environment-account-unavailable",
        },
      ],
    );
    assert.match(invalidCredential.detail, /user-2/u);
    assert.match(invalidTeam.detail, /OPS/u);
    assert.match(unavailableAccount.detail, /user-3/u);
    assert.match(unavailableEnvironment.detail, /ENV/u);

    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepStrictEqual((yield* settings.getSettings).issueTracking.connections, {});
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Layer.succeed(LinearApi.LinearApi, api), ServerSettings.layerTest()),
    ),
  );
});

it.effect("clears a project binding without requiring a connected account", () => {
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed(connection()),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    yield* setLinearProjectBinding({ projectId: PROJECT_ID, binding: null });

    const settings = yield* ServerSettings.ServerSettingsService;
    assert.isNull(
      (yield* settings.getSettings).issueTracking.connections.linear?.projectBindings[PROJECT_ID],
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: {
            connections: {
              linear: {
                projectBindings: {
                  [PROJECT_ID]: { credentialId: "user-1", repository: "ENG" },
                },
              },
            },
          },
        }),
      ),
    ),
  );
});

it.effect("serializes environment-team binding with account disconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const disconnectStarted = yield* Deferred.make<void>();
      const releaseDisconnect = yield* Deferred.make<void>();
      const api = LinearApi.LinearApi.of({
        connection: Effect.succeed({
          ...connection("user-1"),
          environmentAccount: {
            status: "authenticated",
            accountName: "Environment account",
            accountEmail: null,
            projects: [{ id: "team-env", key: "ENV", name: "Environment" }],
          },
        }),
        disconnect: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(disconnectStarted, undefined);
            yield* Deferred.await(releaseDisconnect);
            return connection();
          }),
      } as unknown as LinearApi.LinearApi["Service"]);
      const layer = Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: {
            connections: {
              linear: {
                projectBindings: {
                  [PROJECT_ID]: { credentialId: "user-1", repository: "ENG" },
                },
              },
            },
          },
        }),
      );
      yield* Effect.gen(function* () {
        const disconnect = yield* disconnectLinearAccount({ credentialId: "user-1" }).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(disconnectStarted);
        const bind = yield* setLinearProjectBinding({
          projectId: PROJECT_ID,
          binding: { repository: "ENV" },
        }).pipe(Effect.forkChild);

        yield* Deferred.succeed(releaseDisconnect, undefined);
        yield* Fiber.join(disconnect);
        yield* Fiber.join(bind);

        const settings = yield* ServerSettings.ServerSettingsService;
        const current = yield* settings.getSettings;
        assert.deepStrictEqual(
          current.issueTracking.connections.linear?.projectBindings[PROJECT_ID],
          {
            repository: "ENV",
          },
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("serializes project binding writes with account disconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bindingStarted = yield* Deferred.make<void>();
      const releaseBinding = yield* Deferred.make<void>();
      let connected = true;
      let current = {
        ...DEFAULT_SERVER_SETTINGS,
        issueTracking: {
          connections: {
            linear: {
              ...DEFAULT_SERVER_SETTINGS.issueTracking.connections.linear,
              projectBindings: {} as Record<
                ProjectId,
                null | { readonly credentialId: string; readonly repository: string }
              >,
            },
          },
        },
      };
      const api = LinearApi.LinearApi.of({
        connection: Effect.sync(() => ({
          ...connection(...(connected ? ["user-1"] : [])),
          accounts: connected
            ? [
                {
                  ...account("user-1"),
                  projects: [{ id: "team-1", key: "ENG", name: "Engineering" }],
                },
              ]
            : [],
        })),
        disconnect: () =>
          Effect.sync(() => {
            connected = false;
            return connection();
          }),
      } as unknown as LinearApi.LinearApi["Service"]);
      const settings = ServerSettings.ServerSettingsService.of({
        getSettings: Effect.sync(() => current),
        updateSettings: (patch: {
          readonly issueTracking?: {
            readonly connections?: {
              readonly linear?: {
                readonly projectBindings?: Readonly<
                  Record<
                    ProjectId,
                    null | { readonly credentialId: string; readonly repository: string }
                  >
                >;
              };
            };
          };
        }) =>
          Effect.gen(function* () {
            const binding = patch.issueTracking?.connections?.linear?.projectBindings?.[PROJECT_ID];
            if (binding !== undefined && binding !== null) {
              yield* Deferred.succeed(bindingStarted, undefined);
              yield* Deferred.await(releaseBinding);
            }
            current = {
              ...current,
              issueTracking: {
                connections: {
                  linear: {
                    ...current.issueTracking.connections.linear,
                    projectBindings: {
                      ...current.issueTracking.connections.linear?.projectBindings,
                      ...(binding === undefined ? {} : { [PROJECT_ID]: binding }),
                    },
                  },
                },
              },
            };
            return current;
          }),
      } as unknown as ServerSettings.ServerSettingsService["Service"]);
      const layer = Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        Layer.succeed(ServerSettings.ServerSettingsService, settings),
      );
      const binding = yield* setLinearProjectBinding({
        projectId: PROJECT_ID,
        binding: { credentialId: "user-1", repository: "ENG" },
      }).pipe(Effect.provide(layer), Effect.forkChild);
      yield* Deferred.await(bindingStarted);
      const disconnect = yield* disconnectLinearAccount({ credentialId: "user-1" }).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      assert.isTrue(connected);

      yield* Deferred.succeed(releaseBinding, undefined);
      yield* Fiber.join(binding);
      yield* Fiber.join(disconnect);
      assert.isNull(current.issueTracking.connections.linear?.projectBindings[PROJECT_ID]);
      assert.isFalse(connected);
    }),
  ),
);

it.effect("keeps a key when clearing its project bindings fails", () => {
  let keyStored = true;
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed(connection("user-1")),
    disconnect: () =>
      Effect.sync(() => {
        keyStored = false;
        return connection();
      }),
  } as unknown as LinearApi.LinearApi["Service"]);
  const settings = ServerSettings.ServerSettingsService.of({
    getSettings: Effect.succeed({
      ...DEFAULT_SERVER_SETTINGS,
      issueTracking: {
        connections: {
          linear: {
            ...DEFAULT_SERVER_SETTINGS.issueTracking.connections.linear,
            projectBindings: { [PROJECT_ID]: { credentialId: "user-1", repository: "ENG" } },
          },
        },
      },
    }),
    updateSettings: () =>
      Effect.fail(
        new ServerSettingsError({ settingsPath: "test", operation: "write-file", cause: "test" }),
      ),
  } as unknown as ServerSettings.ServerSettingsService["Service"]);

  return Effect.gen(function* () {
    const result = yield* Effect.exit(disconnectLinearAccount({ credentialId: "user-1" }));
    assert.isTrue(Exit.isFailure(result));
    assert.isTrue(keyStored);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        Layer.succeed(ServerSettings.ServerSettingsService, settings),
      ),
    ),
  );
});

it.effect("restores project bindings when credential deletion fails", () => {
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed(connection("user-1")),
    disconnect: () =>
      Effect.fail(
        new LinearApi.LinearApiError({
          operation: "disconnect",
          reason: "failed",
        }),
      ),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    const error = yield* Effect.flip(disconnectLinearAccount({ credentialId: "user-1" }));
    assert.strictEqual(error._tag, "LinearApiError");

    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepStrictEqual(
      (yield* settings.getSettings).issueTracking.connections.linear?.projectBindings,
      {
        [PROJECT_ID]: { credentialId: "user-1", repository: "ENG" },
      },
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: {
            connections: {
              linear: {
                projectBindings: {
                  [PROJECT_ID]: { credentialId: "user-1", repository: "ENG" },
                },
              },
            },
          },
        }),
      ),
    ),
  );
});
