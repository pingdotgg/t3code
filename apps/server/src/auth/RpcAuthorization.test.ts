import {
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthAccessWriteScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  IssueTrackerKind,
  SecretProviderId,
  ThreadId,
  BlenderJobId,
  type AuthEnvironmentScope,
  TurnItemId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  RunId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("keeps triage, which seeds an agent that reads logs and the database, behind operate scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareTriage)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [WS_METHODS.terminalObserve, WS_METHODS.subscribeTerminalMetadata]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalClose,
      WS_METHODS.previewStopLocalServer,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("lets thread readers observe and refresh checkout branches", () => {
    for (const method of [WS_METHODS.subscribeVcsBranch, WS_METHODS.vcsRefreshBranch]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });

  it("still lets readers load settings the way installed Swift clients ask", () => {
    expect(requiredScopeForRpcMethod("server.getSettings")).toBe(AuthOrchestrationReadScope);
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }),
  );
});

it.effect("allows issue reads but requires a source-control grant before commenting", () =>
  Effect.gen(function* () {
    const tested = [WS_METHODS.issuesList, WS_METHODS.issuesComment] as const;
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
          !(tested as ReadonlyArray<string>).includes(tag),
      ),
    );
    const comments: string[] = [];
    const handlers = Layer.mergeAll(
      group.toLayerHandler(WS_METHODS.issuesList, () =>
        Effect.succeed({ entries: [], trackers: [], errors: [], viewers: {}, nextCursors: {} }),
      ),
      group.toLayerHandler(WS_METHODS.issuesComment, ({ body }) =>
        Effect.sync(() => {
          comments.push(body);
        }),
      ),
    );
    const reader = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([AuthOrchestrationReadScope]))),
    );
    const comment = {
      projectId: ProjectId.make("web"),
      tracker: IssueTrackerKind.make("github"),
      scope: "acme/web",
      key: "42",
      body: "Repro attached.",
    };

    expect((yield* reader[WS_METHODS.issuesList]({ state: "open" })).entries).toEqual([]);
    expect(yield* reader[WS_METHODS.issuesComment](comment).pipe(Effect.flip)).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthSourceControlWriteScope,
    });
    expect(comments).toEqual([]);

    const writer = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          handlers,
          RpcAuthorization.layer([AuthOrchestrationReadScope, AuthSourceControlWriteScope]),
        ),
      ),
    );
    yield* writer[WS_METHODS.issuesComment](comment);
    expect(comments).toEqual(["Repro attached."]);
  }).pipe(Effect.scoped),
);

it.effect("reads a linked environment's thread only for a client that may read threads here", () =>
  Effect.gen(function* () {
    const linkedThreadTags = [
      WS_METHODS.peerLinksSubscribeThread,
      WS_METHODS.peerLinksThreadHistoryPage,
      WS_METHODS.peerLinksThreadItem,
      WS_METHODS.peerLinksNames,
    ] as const;
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof linkedThreadTags)[number]> =>
          !(linkedThreadTags as ReadonlyArray<string>).includes(tag),
      ),
    );
    const read: string[] = [];
    const input = {
      environmentId: EnvironmentId.make("environment-box"),
      threadId: ThreadId.make("thread:box"),
    };
    const handlers = group.toLayer({
      [WS_METHODS.peerLinksSubscribeThread]: ({ threadId }) =>
        Stream.sync(() => {
          read.push(threadId);
          return { kind: "synchronized" as const };
        }),
      [WS_METHODS.peerLinksThreadHistoryPage]: () => Effect.die("unused"),
      [WS_METHODS.peerLinksThreadItem]: ({ threadId }) =>
        Effect.sync(() => {
          read.push(threadId);
          return { item: null };
        }),
      // A thread link resolves to the linked environment by its name.
      [WS_METHODS.peerLinksNames]: () =>
        Effect.succeed({ links: [{ environmentId: input.environmentId, label: "Box" }] }),
    });
    // Managing links and writing settings here say nothing about reading threads.
    const outsider = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          handlers,
          RpcAuthorization.layer([AuthAccessWriteScope, AuthSettingsWriteScope]),
        ),
      ),
    );
    const refused = {
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthOrchestrationReadScope,
    };
    expect(
      yield* outsider[WS_METHODS.peerLinksSubscribeThread](input).pipe(
        Stream.runCollect,
        Effect.flip,
      ),
    ).toMatchObject(refused);
    expect(
      yield* outsider[WS_METHODS.peerLinksThreadItem]({
        ...input,
        itemId: TurnItemId.make("item:1"),
      }).pipe(Effect.flip),
    ).toMatchObject(refused);
    expect(
      yield* outsider[WS_METHODS.peerLinksThreadHistoryPage]({ ...input, cursor: "c" }).pipe(
        Effect.flip,
      ),
    ).toMatchObject(refused);
    expect(read).toEqual([]);
    expect(yield* outsider[WS_METHODS.peerLinksNames]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthOrchestrationReadScope,
    });

    const reader = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([AuthOrchestrationReadScope]))),
    );
    expect(
      Array.from(yield* reader[WS_METHODS.peerLinksSubscribeThread](input).pipe(Stream.runCollect)),
    ).toEqual([{ kind: "synchronized" }]);
    expect(read).toEqual([input.threadId]);
    expect((yield* reader[WS_METHODS.peerLinksNames]({})).links).toEqual([
      { environmentId: input.environmentId, label: "Box" },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("pairs a client with a linked environment only for one that may hand out access", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.peerLinksPairClient
        > => tag !== WS_METHODS.peerLinksPairClient,
      ),
    );
    let asked = 0;
    const environmentId = EnvironmentId.make("environment-box");
    const handlers = group.toLayerHandler(WS_METHODS.peerLinksPairClient, () =>
      Effect.sync(() => {
        asked++;
        return {
          type: "unsupported" as const,
          reason: "link_access" as const,
          environmentId,
          label: "Box",
          urls: [],
        };
      }),
    );
    // Running agents and reading the access list do not include handing access out.
    const operator = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          handlers,
          RpcAuthorization.layer([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
        ),
      ),
    );
    expect(
      yield* operator[WS_METHODS.peerLinksPairClient]({ environmentId }).pipe(Effect.flip),
    ).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthAccessWriteScope,
    });
    expect(asked).toBe(0);

    const manager = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([AuthAccessWriteScope]))),
    );
    expect((yield* manager[WS_METHODS.peerLinksPairClient]({ environmentId })).type).toBe(
      "unsupported",
    );
    expect(asked).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect.each([WS_METHODS.subscribeVcsBranch, WS_METHODS.subscribeVcsStatus] as const)(
  "enforces read permission on stream %s",
  (method) =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            keyof typeof RPC_REQUIRED_SCOPES,
            typeof WS_METHODS.subscribeVcsBranch | typeof WS_METHODS.subscribeVcsStatus
          > => tag !== WS_METHODS.subscribeVcsBranch && tag !== WS_METHODS.subscribeVcsStatus,
        ),
      );
      let handled = 0;
      const handlers = Layer.mergeAll(
        group.toLayerHandler(WS_METHODS.subscribeVcsBranch, () =>
          Stream.fromEffect(
            Effect.sync(() => {
              handled++;
              return { refName: "main" };
            }),
          ),
        ),
        group.toLayerHandler(WS_METHODS.subscribeVcsStatus, () =>
          Stream.fromEffect(
            Effect.sync(() => {
              handled++;
            }),
          ).pipe(Stream.drain),
        ),
      );
      const denied = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([]))),
      );
      expect(
        yield* Stream.runDrain(
          method === WS_METHODS.subscribeVcsBranch
            ? denied[method]({ cwd: "/repo" }).pipe(Stream.drain)
            : denied[method]({ cwd: "/repo" }).pipe(Stream.drain),
        ).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
      expect(handled).toBe(0);
      const granted = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([AuthOrchestrationReadScope]))),
      );
      yield* Stream.runDrain(
        method === WS_METHODS.subscribeVcsBranch
          ? granted[method]({ cwd: "/repo" }).pipe(Stream.drain)
          : granted[method]({ cwd: "/repo" }).pipe(Stream.drain),
      );
      expect(handled).toBe(1);
    }),
);

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      yield* client[WS_METHODS.serverUpdateSettings]({
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: ProviderInstanceId.make("codex_work"),
          instance: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              {
                name: "OPENAI_API_KEY",
                sensitive: true,
                value: {
                  provider: SecretProviderId.make("personal"),
                  reference: "op://Private/OpenAI/credential",
                },
              },
            ],
          },
        },
      });
      expect(handled).toBe(2);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      // Removing a secret provider clears settings fields that read from it.
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { secretProviders: { [SecretProviderId.make("personal")]: null } },
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(2);
    }),
  );

  it.effect(
    "does not let a settings grant manage providers or turn off T3 Connect device approval",
    () =>
      Effect.gen(function* () {
        let handled = 0;
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
                Effect.sync(() => {
                  handled++;
                  return DEFAULT_SERVER_SETTINGS;
                }),
              ),
              RpcAuthorization.layer([AuthSettingsWriteScope]),
            ),
          ),
        );
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: {},
            providerInstanceMutation,
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: { secretProviders: { [SecretProviderId.make("personal")]: null } },
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: { requireConnectDeviceApproval: false },
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthAccessWriteScope });
        // Turning Blender on is a setting; choosing the executable it runs is not.
        yield* client[WS_METHODS.serverUpdateSettings]({ patch: { blender: { enabled: true } } });
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: { blender: { executablePath: "/tmp/payload" } },
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
        // A reference names any secret the store holds, and the host entry names where it goes.
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: {
              simlockDeviceHosts: [
                {
                  kind: "simlock",
                  id: "simlock_evil",
                  label: "Gateway",
                  gatewayUrl: "https://attacker.example",
                  agentToken: {
                    provider: SecretProviderId.make("personal"),
                    reference: "op://Private/OpenAI/credential",
                  },
                  maxLeases: 2,
                  maxLeaseMinutes: 60,
                },
              ],
            },
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
        expect(handled).toBe(1);
      }),
  );

  it.effect("does not let a settings grant send a named secret to a gateway it picks", () =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            keyof typeof RPC_REQUIRED_SCOPES,
            typeof WS_METHODS.deviceSimlockIdentity
          > => tag !== WS_METHODS.deviceSimlockIdentity,
        ),
      );
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.deviceSimlockIdentity, () =>
              Effect.sync(() => {
                handled++;
                return {
                  gatewayUrl: "https://attacker.example",
                  signedInAs: "agent",
                  tokenSource: "entered" as const,
                };
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.deviceSimlockIdentity]({
        gatewayUrl: "https://attacker.example",
        agentToken: "typed-token",
      });
      expect(handled).toBe(1);
      expect(
        yield* client[WS_METHODS.deviceSimlockIdentity]({
          gatewayUrl: "https://attacker.example",
          agentToken: {
            provider: SecretProviderId.make("personal"),
            reference: "op://Private/OpenAI/credential",
          },
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(1);
    }),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }),
);

describe("thread context authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.gitRunStackedAction> =>
        tag !== WS_METHODS.gitRunStackedAction,
    ),
  );

  it.effect.each(["commit", "create_pr", "commit_push_pr"] as const)(
    "%s needs thread read permission only when generating a PR from a thread",
    (action) =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const handler = group.toLayerHandler(WS_METHODS.gitRunStackedAction, ({ actionId }) =>
          Stream.fromEffect(Effect.sync(() => handled.push(actionId))).pipe(Stream.drain),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handler, RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        );
        const input = { actionId: "without-thread", cwd: "/repo", action };
        const withThread = { ...input, actionId: "with-thread", threadId: ThreadId.make("thread") };
        yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](input));
        if (action === "create_pr" || action === "commit_push_pr") {
          expect(
            yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread)).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
          expect(handled).toEqual(["without-thread"]);
        } else {
          yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread));
          expect(handled).toEqual(["without-thread", "with-thread"]);
        }
        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handler,
              RpcAuthorization.layer([AuthSourceControlWriteScope, AuthOrchestrationReadScope]),
            ),
          ),
        );
        yield* Stream.runDrain(
          reader[WS_METHODS.gitRunStackedAction]({ ...withThread, actionId: "allowed" }),
        );
        expect(handled.at(-1)).toBe("allowed");
      }),
  );
});

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "native-app-icon", app: { _tag: "app-id", appId: "com.apple.calculator" } },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
      { _tag: "native-app-icon", app: { _tag: "app-path", path: "/private/Secret.app" } },
      // Derived from workspace files, so it needs what reading them does.
      {
        _tag: "blender-output",
        threadId: ThreadId.make("thread"),
        jobId: BlenderJobId.make("job"),
        output: "preview",
      },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(2);
  }),
);

it.effect("requires host execution, thread operation and file reads to open a Blender scene", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.blenderOpenScene> =>
          tag !== WS_METHODS.blenderOpenScene,
      ),
    );
    const openWith = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
      RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.blenderOpenScene, (input) =>
              Effect.succeed({
                id: BlenderJobId.make("job"),
                threadId: input.threadId,
                sequence: 0,
                input: input.path,
                outputs: ["preview" as const],
                createdAt: 0,
                status: "queued" as const,
              }),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
        Effect.flatMap((client) =>
          client[WS_METHODS.blenderOpenScene]({
            threadId: ThreadId.make("thread"),
            path: "models/chair.blend",
          }),
        ),
        Effect.map((job) => job.status),
        Effect.catchTags({
          EnvironmentAuthorizationError: (error) => Effect.succeed(error.requiredPermission),
        }),
      );
    expect(
      yield* Effect.all([
        openWith([AuthOrchestrationOperateScope, AuthFilesystemReadScope]),
        openWith([AuthTerminalOperateScope, AuthFilesystemReadScope]),
        openWith([AuthTerminalOperateScope, AuthOrchestrationOperateScope]),
        openWith([
          AuthTerminalOperateScope,
          AuthOrchestrationOperateScope,
          AuthFilesystemReadScope,
        ]),
      ]),
    ).toEqual([
      AuthTerminalOperateScope,
      AuthOrchestrationOperateScope,
      AuthFilesystemReadScope,
      "queued",
    ]);
  }),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }),
);

it.effect("requires provider management to send /logout through chat", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof ORCHESTRATION_V2_WS_METHODS.dispatchCommand
        > => tag !== ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
      ),
    );
    const handled: string[] = [];
    const handler = group.toLayerHandler(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, (command) =>
      Effect.sync(() => {
        handled.push(command.commandId);
        return { sequence: 1 };
      }),
    );
    const message = (commandId: string, text: string) => ({
      type: "message.dispatch" as const,
      createdBy: "user" as const,
      creationSource: "web" as const,
      commandId: CommandId.make(commandId),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make(commandId),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" as const },
    });
    const edit = (commandId: string) => ({
      type: "queued-run.edit" as const,
      commandId: CommandId.make(commandId),
      threadId: ThreadId.make("thread"),
      runId: RunId.make("run"),
      text: "/logout",
    });
    // With an attachment, `/logout` reaches the provider as a prompt, not a sign-out.
    const attachments = [
      { type: "image" as const, id: "shot", name: "shot.png", mimeType: "image/png", sizeBytes: 1 },
    ];
    const operator = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(handler, RpcAuthorization.layer([AuthOrchestrationOperateScope]))),
    );
    const dispatch = operator[ORCHESTRATION_V2_WS_METHODS.dispatchCommand];
    yield* dispatch(message("hello", "hello"));
    yield* dispatch({ ...message("attached", "/logout"), attachments });
    yield* dispatch({ ...edit("attached-edit"), attachments });
    // This edit keeps the queued attachments; message intake decides it.
    yield* dispatch(edit("kept-attachments-edit"));
    for (const command of [message("logout", " /LOGOUT "), { ...edit("edit"), attachments: [] }]) {
      expect(yield* dispatch(command).pipe(Effect.flip)).toMatchObject({
        requiredPermission: AuthProvidersManageScope,
      });
    }
    const manager = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          handler,
          RpcAuthorization.layer([AuthOrchestrationOperateScope, AuthProvidersManageScope]),
        ),
      ),
    );
    yield* manager[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](message("manager", "/logout"));
    expect(handled).toEqual([
      "hello",
      "attached",
      "attached-edit",
      "kept-attachments-edit",
      "manager",
    ]);
  }).pipe(Effect.scoped),
);
