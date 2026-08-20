import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type LinearProjectBinding,
  type ProjectId,
  ServerSettingsError,
} from "@t3tools/contracts";
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
  updateLegacyLinearProjectTeams,
} from "./LinearConnection.ts";

const account = (credentialId: string) => ({
  credentialId,
  status: "authenticated" as const,
  accountName: credentialId,
  accountEmail: null,
  teams: [],
});
const PROJECT_ID = "project_1" as ProjectId;

const connection = (...credentialIds: ReadonlyArray<string>) => ({
  status: credentialIds.length === 0 ? ("unauthenticated" as const) : ("authenticated" as const),
  hasStoredToken: credentialIds.length > 0,
  accountName: credentialIds[0] ?? null,
  accountEmail: null,
  teams: [],
  accounts: credentialIds.map(account),
});

const connectionWithTeam = (teamKey: string, ...credentialIds: ReadonlyArray<string>) => {
  const value = connection(...credentialIds);
  const teams = [{ id: `team-${teamKey}`, key: teamKey, name: teamKey }];
  return {
    ...value,
    teams,
    accounts: value.accounts.map((entry) => ({ ...entry, teams })),
  };
};

it("emits tombstones only for bindings owned by the disconnected account", () => {
  assert.deepStrictEqual(
    clearCredentialBindings(
      {
        project_1: { credentialId: "user-1", teamKey: "ENG" },
        project_2: { credentialId: "user-2", teamKey: "OPS" },
        project_3: { credentialId: "user-1", teamKey: "MOBILE" },
      },
      "user-1",
    ),
    { project_1: null, project_3: null },
  );
});

it.effect("migrates a legacy project binding before appending a second account", () => {
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed(connection("user-1")),
    connect: () => Effect.succeed(connection("user-1", "user-2")),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    yield* connectLinearAccount("lin_api_two", "add");
    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepStrictEqual((yield* settings.getSettings).issueTracking.linear.projectBindings, {
      [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: { linear: { projectTeams: { [PROJECT_ID]: "ENG" } } },
        }),
      ),
    ),
  );
});

it.effect("keeps environment-token project teams unbound when adding a saved account", () => {
  const api = LinearApi.LinearApi.of({
    environmentTokenConfigured: true,
    connection: Effect.succeed({ ...connection(), status: "authenticated" as const }),
    connect: () => Effect.succeed(connection("user-2")),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    yield* connectLinearAccount("lin_api_two", "add");
    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepStrictEqual((yield* settings.getSettings).issueTracking.linear.projectBindings, {});
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: { linear: { projectTeams: { [PROJECT_ID]: "ENG" } } },
        }),
      ),
    ),
  );
});

it.effect(
  "keeps legacy project teams on the migrated saved account when an env token exists",
  () => {
    const api = LinearApi.LinearApi.of({
      environmentTokenConfigured: true,
      connection: Effect.succeed({
        ...connection("user-1"),
        migratedCredentialId: "user-1",
      }),
      completeLegacyMigration: Effect.void,
    } as unknown as LinearApi.LinearApi["Service"]);

    return Effect.gen(function* () {
      yield* linearConnectionStatus;
      const settings = yield* ServerSettings.ServerSettingsService;
      assert.deepStrictEqual((yield* settings.getSettings).issueTracking.linear.projectBindings, {
        [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(LinearApi.LinearApi, api),
          ServerSettings.layerTest({
            issueTracking: { linear: { projectTeams: { [PROJECT_ID]: "ENG" } } },
          }),
        ),
      ),
    );
  },
);

it.effect("retries legacy binding migration when its first settings write fails", () => {
  let migrationComplete = false;
  let writes = 0;
  let current = {
    ...DEFAULT_SERVER_SETTINGS,
    issueTracking: {
      linear: {
        ...DEFAULT_SERVER_SETTINGS.issueTracking.linear,
        projectTeams: { [PROJECT_ID]: "ENG" },
      },
    },
  };
  const api = LinearApi.LinearApi.of({
    environmentTokenConfigured: true,
    connection: Effect.sync(() => ({
      ...connection("user-1"),
      ...(migrationComplete ? {} : { migratedCredentialId: "user-1" }),
    })),
    completeLegacyMigration: Effect.sync(() => void (migrationComplete = true)),
  } as unknown as LinearApi.LinearApi["Service"]);
  const settings = ServerSettings.ServerSettingsService.of({
    getSettings: Effect.sync(() => current),
    updateSettings: (patch: {
      readonly issueTracking?: {
        readonly linear?: {
          readonly projectBindings?: Readonly<Record<ProjectId, LinearProjectBinding | null>>;
        };
      };
    }) =>
      Effect.suspend(() => {
        writes += 1;
        if (writes === 1) {
          return Effect.fail(
            new ServerSettingsError({
              settingsPath: "test",
              operation: "write-file",
              cause: "test",
            }),
          );
        }
        current = {
          ...current,
          issueTracking: {
            linear: {
              ...current.issueTracking.linear,
              projectBindings: {
                ...current.issueTracking.linear.projectBindings,
                ...patch.issueTracking?.linear?.projectBindings,
              },
            },
          },
        };
        return Effect.succeed(current);
      }),
  } as unknown as ServerSettings.ServerSettingsService["Service"]);
  const layer = Layer.mergeAll(
    Layer.succeed(LinearApi.LinearApi, api),
    Layer.succeed(ServerSettings.ServerSettingsService, settings),
  );

  return Effect.gen(function* () {
    assert.isTrue(Exit.isFailure(yield* Effect.exit(linearConnectionStatus)));
    assert.isFalse(migrationComplete);

    yield* linearConnectionStatus;
    assert.isTrue(migrationComplete);
    assert.deepStrictEqual(current.issueTracking.linear.projectBindings, {
      [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
    });
  }).pipe(Effect.provide(layer));
});

it.effect("does not disconnect an environment token through an old empty request", () => {
  let disconnected = false;
  const api = LinearApi.LinearApi.of({
    environmentTokenConfigured: true,
    connection: Effect.succeed({ ...connection(), status: "authenticated" as const }),
    disconnect: () => Effect.sync(() => void (disconnected = true)).pipe(Effect.as(connection())),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    const error = yield* Effect.flip(disconnectLinearAccount(undefined));

    assert.strictEqual(error._tag, "LinearAccountSelectionRequiredError");
    if (error._tag !== "LinearAccountSelectionRequiredError") return;
    assert.strictEqual(error.detail, "Choose the Linear account to disconnect.");
    assert.isFalse(disconnected);
    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepStrictEqual((yield* settings.getSettings).issueTracking.linear.projectBindings, {});
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: { linear: { projectTeams: { [PROJECT_ID]: "ENG" } } },
        }),
      ),
    ),
  );
});

it.effect(
  "replaces the old account and remaps its project bindings for legacy connect calls",
  () => {
    let credentialIds = ["user-1"];
    const disconnected: Array<string> = [];
    const api = LinearApi.LinearApi.of({
      connection: Effect.sync(() => connectionWithTeam("ENG", ...credentialIds)),
      connect: () =>
        Effect.sync(() => {
          credentialIds = ["user-1", "user-2"];
          return connectionWithTeam("ENG", ...credentialIds);
        }),
      disconnect: ({ credentialId }: { readonly credentialId: string }) =>
        Effect.sync(() => {
          disconnected.push(credentialId);
          credentialIds = credentialIds.filter((id) => id !== credentialId);
          return connectionWithTeam("ENG", ...credentialIds);
        }),
    } as unknown as LinearApi.LinearApi["Service"]);

    return Effect.gen(function* () {
      const result = yield* connectLinearAccount("lin_api_two");
      assert.deepStrictEqual(
        result.accounts.map(({ credentialId }) => credentialId),
        ["user-2"],
      );
      assert.deepStrictEqual(disconnected, ["user-1"]);

      const settings = yield* ServerSettings.ServerSettingsService;
      assert.deepStrictEqual((yield* settings.getSettings).issueTracking.linear.projectBindings, {
        [PROJECT_ID]: { credentialId: "user-2", teamKey: "ENG" },
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(LinearApi.LinearApi, api),
          ServerSettings.layerTest({
            issueTracking: {
              linear: {
                projectBindings: {
                  [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
                },
              },
            },
          }),
        ),
      ),
    );
  },
);

it.effect("clears old bindings unavailable to a legacy replacement account", () => {
  const engineering = [{ id: "team-eng", key: "ENG", name: "Engineering" }];
  const operations = [{ id: "team-ops", key: "OPS", name: "Operations" }];
  let current: LinearApi.LinearConnectionResult = {
    ...connection("user-1"),
    accounts: [{ ...account("user-1"), teams: engineering }],
  };
  const api = LinearApi.LinearApi.of({
    connection: Effect.sync(() => current),
    connect: () =>
      Effect.sync(() => {
        current = {
          ...connection("user-1", "user-2"),
          accounts: [
            { ...account("user-1"), teams: engineering },
            { ...account("user-2"), teams: operations },
          ],
        };
        return { ...current, connectedCredentialId: "user-2" };
      }),
    disconnect: () =>
      Effect.sync(() => {
        current = {
          ...connection("user-2"),
          accounts: [{ ...account("user-2"), teams: operations }],
        };
        return current;
      }),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    yield* connectLinearAccount("lin_api_two");
    const settings = yield* ServerSettings.ServerSettingsService;
    const linear = (yield* settings.getSettings).issueTracking.linear;
    assert.deepStrictEqual(linear.projectBindings, { [PROJECT_ID]: null });
    assert.deepStrictEqual(linear.projectTeams, {});
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: {
            linear: {
              projectBindings: {
                [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
              },
              projectTeams: { [PROJECT_ID]: "ENG" },
            },
          },
        }),
      ),
    ),
  );
});

it.effect("keeps replacement bindings usable when removing the old key fails", () => {
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed(connectionWithTeam("ENG", "user-1")),
    connect: () => Effect.succeed(connectionWithTeam("ENG", "user-1", "user-2")),
    disconnect: () =>
      Effect.fail(
        new LinearApi.LinearApiError({
          operation: "disconnect",
          reason: "failed",
        }),
      ),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    const error = yield* Effect.flip(connectLinearAccount("lin_api_two"));
    assert.strictEqual(error._tag, "LinearApiError");

    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepStrictEqual((yield* settings.getSettings).issueTracking.linear.projectBindings, {
      [PROJECT_ID]: { credentialId: "user-2", teamKey: "ENG" },
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: {
            linear: {
              projectBindings: {
                [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
              },
            },
          },
        }),
      ),
    ),
  );
});

it.effect("restores unavailable bindings when legacy replacement removal fails", () => {
  const engineering = [{ id: "team-eng", key: "ENG", name: "Engineering" }];
  const operations = [{ id: "team-ops", key: "OPS", name: "Operations" }];
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed({
      ...connection("user-1"),
      accounts: [{ ...account("user-1"), teams: engineering }],
    }),
    connect: () =>
      Effect.succeed({
        ...connection("user-1", "user-2"),
        connectedCredentialId: "user-2",
        accounts: [
          { ...account("user-1"), teams: engineering },
          { ...account("user-2"), teams: operations },
        ],
      }),
    disconnect: () =>
      Effect.fail(
        new LinearApi.LinearApiError({
          operation: "disconnect",
          reason: "failed",
        }),
      ),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    yield* Effect.flip(connectLinearAccount("lin_api_two"));
    const settings = yield* ServerSettings.ServerSettingsService;
    const linear = (yield* settings.getSettings).issueTracking.linear;
    assert.deepStrictEqual(linear.projectBindings, {
      [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
    });
    assert.deepStrictEqual(linear.projectTeams, { [PROJECT_ID]: "ENG" });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: {
            linear: {
              projectBindings: {
                [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
              },
              projectTeams: { [PROJECT_ID]: "ENG" },
            },
          },
        }),
      ),
    ),
  );
});

it.effect("replaces all accounts when a legacy connect reuses one saved credential", () => {
  let credentialIds = ["user-1", "user-2"];
  const api = LinearApi.LinearApi.of({
    connection: Effect.sync(() => connectionWithTeam("ENG", ...credentialIds)),
    connect: () =>
      Effect.succeed({
        ...connectionWithTeam("ENG", "user-1", "user-2"),
        connectedCredentialId: "user-2",
      }),
    disconnect: ({ credentialId }: { readonly credentialId: string }) =>
      Effect.sync(() => {
        credentialIds = credentialIds.filter((id) => id !== credentialId);
        return connectionWithTeam("ENG", ...credentialIds);
      }),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    const result = yield* connectLinearAccount("lin_api_two");
    assert.deepStrictEqual(
      result.accounts.map(({ credentialId }) => credentialId),
      ["user-2"],
    );

    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepStrictEqual((yield* settings.getSettings).issueTracking.linear.projectBindings, {
      [PROJECT_ID]: { credentialId: "user-2", teamKey: "ENG" },
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: {
            linear: {
              projectBindings: {
                [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
              },
            },
          },
        }),
      ),
    ),
  );
});

it.effect("rejects project bindings outside the selected saved account", () => {
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed({
      ...connection("user-1"),
      accounts: [
        {
          ...account("user-1"),
          teams: [{ id: "team-1", key: "ENG", name: "Engineering" }],
        },
      ],
    }),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    const invalidCredential = yield* Effect.flip(
      setLinearProjectBinding({
        projectId: PROJECT_ID,
        binding: { credentialId: "user-2", teamKey: "ENG" },
      }),
    );
    const invalidTeam = yield* Effect.flip(
      setLinearProjectBinding({
        projectId: PROJECT_ID,
        binding: { credentialId: "user-1", teamKey: "OPS" },
      }),
    );
    const unavailableAccount = yield* Effect.flip(
      setLinearProjectBinding({
        projectId: PROJECT_ID,
        binding: { credentialId: "user-3", teamKey: "ENG" },
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
                  teams: [{ id: "team-1", key: "ENG", name: "Engineering" }],
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
        binding: { teamKey: "ENV" },
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
        teamKey: error.teamKey,
        bindingRejection: error.bindingRejection,
      })),
      [
        {
          projectId: PROJECT_ID,
          credentialId: "user-2",
          teamKey: "ENG",
          bindingRejection: "unknown-credential",
        },
        {
          projectId: PROJECT_ID,
          credentialId: "user-1",
          teamKey: "OPS",
          bindingRejection: "team-unavailable",
        },
        {
          projectId: PROJECT_ID,
          credentialId: "user-3",
          teamKey: "ENG",
          bindingRejection: "account-unavailable",
        },
        {
          projectId: PROJECT_ID,
          credentialId: undefined,
          teamKey: "ENV",
          bindingRejection: "environment-account-unavailable",
        },
      ],
    );
    assert.match(invalidCredential.detail, /user-2/u);
    assert.match(invalidTeam.detail, /OPS/u);
    assert.match(unavailableAccount.detail, /user-3/u);
    assert.match(unavailableEnvironment.detail, /ENV/u);

    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepStrictEqual((yield* settings.getSettings).issueTracking.linear.projectBindings, {});
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
    assert.isNull((yield* settings.getSettings).issueTracking.linear.projectBindings[PROJECT_ID]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: {
            linear: {
              projectBindings: {
                [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
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
        environmentTokenConfigured: true,
        connection: Effect.succeed({
          ...connection("user-1"),
          environmentAccount: {
            status: "authenticated",
            accountName: "Environment account",
            accountEmail: null,
            teams: [{ id: "team-env", key: "ENV", name: "Environment" }],
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
            linear: {
              projectBindings: {
                [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
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
          binding: { teamKey: "ENV" },
        }).pipe(Effect.forkChild);

        yield* Deferred.succeed(releaseDisconnect, undefined);
        yield* Fiber.join(disconnect);
        yield* Fiber.join(bind);

        const settings = yield* ServerSettings.ServerSettingsService;
        const current = yield* settings.getSettings;
        assert.isUndefined(current.issueTracking.linear.projectBindings[PROJECT_ID]);
        assert.strictEqual(current.issueTracking.linear.projectTeams[PROJECT_ID], "ENV");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("keeps bindings when legacy connection inspection fails", () => {
  const api = LinearApi.LinearApi.of({
    connection: Effect.fail(
      new LinearApi.LinearApiError({
        operation: "connection",
        reason: "failed",
      }),
    ),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    const result = yield* Effect.exit(
      updateLegacyLinearProjectTeams({
        issueTracking: { linear: { projectTeams: { [PROJECT_ID]: "ENG" } } },
      }),
    );
    assert.isTrue(Exit.isFailure(result));
    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepStrictEqual((yield* settings.getSettings).issueTracking.linear.projectBindings, {
      [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: {
            linear: {
              projectBindings: {
                [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
              },
              projectTeams: { [PROJECT_ID]: "ENG" },
            },
          },
        }),
      ),
    ),
  );
});

it.effect("keeps unchanged bindings for an unverified Linear account", () => {
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed({
      ...connection("user-1"),
      accounts: [{ ...account("user-1"), status: "unverified", teams: [] }],
    }),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    yield* updateLegacyLinearProjectTeams({
      issueTracking: { linear: { projectTeams: { [PROJECT_ID]: "ENG" } } },
    });
    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepStrictEqual((yield* settings.getSettings).issueTracking.linear.projectBindings, {
      [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: {
            linear: {
              projectBindings: {
                [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
              },
              projectTeams: { [PROJECT_ID]: "ENG" },
            },
          },
        }),
      ),
    ),
  );
});

it.effect("keeps a racing legacy team patch for an unbound project inactive after disconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const disconnectStarted = yield* Deferred.make<void>();
      const releaseDisconnect = yield* Deferred.make<void>();
      let connected = true;
      const api = LinearApi.LinearApi.of({
        connection: Effect.sync(() =>
          connected
            ? {
                ...connection("user-1"),
                accounts: [
                  {
                    ...account("user-1"),
                    teams: [{ id: "team-1", key: "ENG", name: "Engineering" }],
                  },
                ],
              }
            : connection(),
        ),
        disconnect: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(disconnectStarted, undefined);
            yield* Deferred.await(releaseDisconnect);
            connected = false;
            return connection();
          }),
      } as unknown as LinearApi.LinearApi["Service"]);
      const layer = Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: { linear: { projectBindings: {} } },
        }),
      );

      yield* Effect.gen(function* () {
        const disconnect = yield* disconnectLinearAccount({ credentialId: "user-1" }).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(disconnectStarted);
        const legacyBind = yield* updateLegacyLinearProjectTeams({
          issueTracking: { linear: { projectTeams: { [PROJECT_ID]: "OPS" } } },
        }).pipe(Effect.forkChild);

        yield* Deferred.succeed(releaseDisconnect, undefined);
        yield* Fiber.join(disconnect);
        yield* Fiber.join(legacyBind);

        const settings = yield* ServerSettings.ServerSettingsService;
        const current = yield* settings.getSettings;
        assert.isNull(current.issueTracking.linear.projectBindings[PROJECT_ID]);
        assert.strictEqual(current.issueTracking.linear.projectTeams[PROJECT_ID], "OPS");
        assert.isFalse(connected);
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
          linear: {
            ...DEFAULT_SERVER_SETTINGS.issueTracking.linear,
            projectBindings: {} as Record<
              ProjectId,
              null | { readonly credentialId: string; readonly teamKey: string }
            >,
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
                  teams: [{ id: "team-1", key: "ENG", name: "Engineering" }],
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
            readonly linear?: {
              readonly projectBindings?: Readonly<
                Record<
                  ProjectId,
                  null | { readonly credentialId: string; readonly teamKey: string }
                >
              >;
            };
          };
        }) =>
          Effect.gen(function* () {
            const binding = patch.issueTracking?.linear?.projectBindings?.[PROJECT_ID];
            if (binding !== undefined && binding !== null) {
              yield* Deferred.succeed(bindingStarted, undefined);
              yield* Deferred.await(releaseBinding);
            }
            current = {
              ...current,
              issueTracking: {
                linear: {
                  ...current.issueTracking.linear,
                  projectBindings: {
                    ...current.issueTracking.linear.projectBindings,
                    ...(binding === undefined ? {} : { [PROJECT_ID]: binding }),
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
        binding: { credentialId: "user-1", teamKey: "ENG" },
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
      assert.isNull(current.issueTracking.linear.projectBindings[PROJECT_ID]);
      assert.isFalse(connected);
    }),
  ),
);

it.effect("keeps legacy fallback active when deleting the legacy key fails", () => {
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed({
      ...connection(),
      status: "unauthenticated",
      hasStoredToken: true,
    }),
    disconnect: () =>
      Effect.fail(
        new LinearApi.LinearApiError({
          operation: "disconnect",
          reason: "failed",
        }),
      ),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    const error = yield* Effect.flip(disconnectLinearAccount(undefined));
    assert.strictEqual(error._tag, "LinearApiError");

    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepStrictEqual((yield* settings.getSettings).issueTracking.linear.projectBindings, {});
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: { linear: { projectTeams: { [PROJECT_ID]: "LEGACY" } } },
        }),
      ),
    ),
  );
});

it.effect("lets an old client reconnect after disconnecting its migrated account", () => {
  let connectedId: string | undefined = "user-1";
  const currentConnection = () => {
    if (connectedId === undefined) return connection();
    const teamKey = connectedId === "user-1" ? "ENG" : "OPS";
    return {
      ...connection(connectedId),
      accounts: [
        {
          ...account(connectedId),
          teams: [{ id: `team-${teamKey}`, key: teamKey, name: teamKey }],
        },
      ],
    };
  };
  const api = LinearApi.LinearApi.of({
    connection: Effect.sync(currentConnection),
    connect: () =>
      Effect.sync(() => {
        connectedId = "user-2";
        return { ...currentConnection(), connectedCredentialId: "user-2" };
      }),
    disconnect: () =>
      Effect.sync(() => {
        connectedId = undefined;
        return connection();
      }),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    yield* disconnectLinearAccount(undefined);

    const settings = yield* ServerSettings.ServerSettingsService;
    const disconnected = yield* settings.getSettings;
    assert.isNull(disconnected.issueTracking.linear.projectBindings[PROJECT_ID]);
    assert.deepStrictEqual(disconnected.issueTracking.linear.projectTeams, {});

    yield* connectLinearAccount("lin_api_two");
    yield* updateLegacyLinearProjectTeams({
      issueTracking: { linear: { projectTeams: { [PROJECT_ID]: "OPS" } } },
    });
    const reconnected = yield* settings.getSettings;
    assert.deepStrictEqual(reconnected.issueTracking.linear.projectBindings[PROJECT_ID], {
      credentialId: "user-2",
      teamKey: "OPS",
    });
    assert.strictEqual(reconnected.issueTracking.linear.projectTeams[PROJECT_ID], "OPS");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: { linear: { projectTeams: { [PROJECT_ID]: "ENG" } } },
        }),
      ),
    ),
  );
});

it.effect("keeps the legacy key when saving project tombstones fails", () => {
  let legacyStored = true;
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed({
      ...connection(),
      status: "unauthenticated",
      hasStoredToken: true,
    }),
    disconnect: () =>
      Effect.sync(() => {
        legacyStored = false;
        return connection();
      }),
  } as unknown as LinearApi.LinearApi["Service"]);
  const settings = ServerSettings.ServerSettingsService.of({
    getSettings: Effect.succeed({
      ...DEFAULT_SERVER_SETTINGS,
      issueTracking: {
        linear: {
          ...DEFAULT_SERVER_SETTINGS.issueTracking.linear,
          projectTeams: { [PROJECT_ID]: "LEGACY" },
        },
      },
    }),
    updateSettings: () =>
      Effect.fail(
        new ServerSettingsError({ settingsPath: "test", operation: "write-file", cause: "test" }),
      ),
  } as unknown as ServerSettings.ServerSettingsService["Service"]);

  return Effect.gen(function* () {
    const result = yield* Effect.exit(disconnectLinearAccount(undefined));
    assert.isTrue(Exit.isFailure(result));
    assert.isTrue(legacyStored);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        Layer.succeed(ServerSettings.ServerSettingsService, settings),
      ),
    ),
  );
});

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
        linear: {
          ...DEFAULT_SERVER_SETTINGS.issueTracking.linear,
          projectBindings: { [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" } },
        },
      },
    }),
    updateSettings: () =>
      Effect.fail(
        new ServerSettingsError({ settingsPath: "test", operation: "write-file", cause: "test" }),
      ),
  } as unknown as ServerSettings.ServerSettingsService["Service"]);

  return Effect.gen(function* () {
    const result = yield* Effect.exit(disconnectLinearAccount(undefined));
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
    assert.deepStrictEqual((yield* settings.getSettings).issueTracking.linear.projectBindings, {
      [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
    });
    assert.deepStrictEqual((yield* settings.getSettings).issueTracking.linear.projectTeams, {
      [PROJECT_ID]: "ENG",
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: {
            linear: {
              projectTeams: { [PROJECT_ID]: "ENG" },
              projectBindings: {
                [PROJECT_ID]: { credentialId: "user-1", teamKey: "ENG" },
              },
            },
          },
        }),
      ),
    ),
  );
});

it.effect("uses the only account for an old disconnect call without a payload", () => {
  let disconnected: string | undefined;
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed(connection("user-1")),
    disconnect: ({ credentialId }: { readonly credentialId: string }) => {
      disconnected = credentialId;
      return Effect.succeed(connection());
    },
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    yield* disconnectLinearAccount(undefined);
    assert.strictEqual(disconnected, "user-1");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Layer.succeed(LinearApi.LinearApi, api), ServerSettings.layerTest()),
    ),
  );
});

it.effect("passes an old disconnect call through when only an invalid legacy key remains", () => {
  let legacyStored = true;
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed({
      ...connection(),
      status: "unauthenticated",
      hasStoredToken: true,
    }),
    disconnect: (input: undefined | { readonly credentialId: string }) =>
      input === undefined
        ? Effect.sync(() => {
            legacyStored = false;
            return connection();
          })
        : Effect.die("must disconnect the unverified legacy key"),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    yield* disconnectLinearAccount(undefined);
    assert.isFalse(legacyStored);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Layer.succeed(LinearApi.LinearApi, api), ServerSettings.layerTest()),
    ),
  );
});

it.effect("keeps legacy project teams unbound after connecting a different account", () => {
  let legacyStored = true;
  const api = LinearApi.LinearApi.of({
    connection: Effect.sync(() =>
      legacyStored
        ? { ...connection(), status: "unauthenticated", hasStoredToken: true }
        : connection(),
    ),
    disconnect: () =>
      Effect.sync(() => {
        legacyStored = false;
        return connection();
      }),
    connect: () => Effect.succeed(connection("user-2")),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    yield* disconnectLinearAccount(undefined);
    yield* connectLinearAccount("lin_api_two");

    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepStrictEqual((yield* settings.getSettings).issueTracking.linear.projectBindings, {
      [PROJECT_ID]: null,
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: { linear: { projectTeams: { [PROJECT_ID]: "LEGACY" } } },
        }),
      ),
    ),
  );
});

it.effect("serializes legacy binding migration with disconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const migrationStarted = yield* Deferred.make<void>();
      const releaseMigration = yield* Deferred.make<void>();
      let connected = true;
      let current = {
        ...DEFAULT_SERVER_SETTINGS,
        issueTracking: {
          linear: {
            ...DEFAULT_SERVER_SETTINGS.issueTracking.linear,
            projectTeams: { [PROJECT_ID]: "ENG" },
            projectBindings: {} as Record<
              ProjectId,
              null | { readonly credentialId: string; readonly teamKey: string }
            >,
          },
        },
      };
      const api = LinearApi.LinearApi.of({
        connection: Effect.sync(() => (connected ? connection("user-1") : connection())),
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
            readonly linear?: {
              readonly projectBindings?: Readonly<
                Record<
                  ProjectId,
                  null | { readonly credentialId: string; readonly teamKey: string }
                >
              >;
            };
          };
        }) =>
          Effect.gen(function* () {
            const binding = patch.issueTracking?.linear?.projectBindings?.[PROJECT_ID];
            if (binding !== undefined && binding !== null) {
              yield* Deferred.succeed(migrationStarted, undefined);
              yield* Deferred.await(releaseMigration);
            }
            current = {
              ...current,
              issueTracking: {
                linear: {
                  ...current.issueTracking.linear,
                  projectBindings: {
                    ...current.issueTracking.linear.projectBindings,
                    ...(binding === undefined ? {} : { [PROJECT_ID]: binding }),
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
      const migration = yield* linearConnectionStatus.pipe(Effect.provide(layer), Effect.forkChild);
      yield* Deferred.await(migrationStarted);
      const disconnect = yield* disconnectLinearAccount(undefined).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      assert.isTrue(connected);

      yield* Deferred.succeed(releaseMigration, undefined);
      yield* Fiber.join(migration);
      yield* Fiber.join(disconnect);
      assert.isNull(current.issueTracking.linear.projectBindings[PROJECT_ID]);
      assert.isFalse(connected);
    }),
  ),
);

it.effect("requires a credential for an old disconnect call when accounts are ambiguous", () => {
  const api = LinearApi.LinearApi.of({
    connection: Effect.succeed(connection("user-1", "user-2")),
    disconnect: () => Effect.die("must not delete a key"),
  } as unknown as LinearApi.LinearApi["Service"]);

  return Effect.gen(function* () {
    const error = yield* Effect.flip(disconnectLinearAccount(undefined));
    assert.strictEqual(error._tag, "LinearAccountSelectionRequiredError");
    if (error._tag === "LinearAccountSelectionRequiredError") {
      assert.match(error.detail, /choose.*account/i);
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Layer.succeed(LinearApi.LinearApi, api), ServerSettings.layerTest()),
    ),
  );
});
