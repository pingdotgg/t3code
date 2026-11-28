import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type AuthClientMetadata,
} from "@t3tools/contracts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpServer } from "effect/http";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { assertLocalAgentMcpExecutionAllowed } from "./hubOnly.ts";
import * as TeamMcpAccess from "./mcpAccess.ts";
import * as TeamRepository from "./TeamRepository.ts";
import * as TeamService from "./TeamService.ts";

const testClient: AuthClientMetadata = {
  deviceType: "desktop",
  label: "Test App",
};

const fakeHttpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43210),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const makeTeamLayer = (configOverrides?: Partial<ServerConfig.ServerConfig["Service"]>) => {
  const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
  const configLayer = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const cfg = yield* ServerConfig.ServerConfig;
      return { ...cfg, ...configOverrides };
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-mcp-test-" })),
    Layer.provide(platform),
  );
  const persistence = SqlitePersistence.layerMemory.pipe(Layer.provide(configLayer));
  const secretStore = ServerSecretStore.layer.pipe(
    Layer.provide(configLayer),
    Layer.provide(platform),
  );
  const serverEnv = ServerEnvironment.layer.pipe(
    Layer.provide(secretStore),
    Layer.provide(configLayer),
    Layer.provide(platform),
  );
  const authDeps = Layer.mergeAll(
    persistence,
    secretStore,
    AuthSessions.layer.pipe(Layer.provide(persistence)),
    serverEnv,
  );
  const sessions = SessionStore.layer.pipe(
    Layer.provideMerge(authDeps),
    Layer.provide(configLayer),
    Layer.provide(platform),
  );
  const teamRepo = TeamRepository.layer.pipe(Layer.provide(persistence));
  const teamService = TeamService.layer.pipe(
    Layer.provideMerge(teamRepo),
    Layer.provideMerge(sessions),
    Layer.provide(configLayer),
    Layer.provide(platform),
  );
  const mcpRegistry = McpSessionRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(platform, serverEnv, Layer.succeed(HttpServer.HttpServer, fakeHttpServer)),
    ),
  );
  return Layer.mergeAll(
    platform,
    configLayer,
    persistence,
    secretStore,
    serverEnv,
    sessions,
    teamRepo,
    teamService,
    mcpRegistry,
  );
};

const withThreadCaller = <A, E, R>(
  threadScope: McpInvocationContext.McpThreadInvocationScope,
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, threadScope));

const withClientCaller = <A, E, R>(sessionId: AuthSessionId, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("env-test"),
      capabilities: new Set<McpInvocationContext.McpCapability>(),
      issuedAt: 1_700_000_000_000,
      requestNamespace: "test-client",
      thread: undefined,
      client: {
        sessionId,
        label: "Test OAuth Client",
        access: "full-access",
      },
    }),
  );

describe("Team MCP containment (Plane 1) and hub-only isolation (Plane 2)", () => {
  it.effect("keeps snoozes from member-bound MCP invocations private to the follower", () =>
    Effect.gen(function* () {
      const team = yield* TeamService.TeamService;
      const sessions = yield* SessionStore.SessionStore;
      const owner = yield* sessions.issue({ subject: "mcp-snooze-owner" });
      yield* team.initializeTeam({
        sessionId: owner.sessionId,
        payload: { name: "MCP Snooze", ownerPseudo: "charlie" },
      });
      const invite = yield* team.createInvite({
        sessionId: owner.sessionId,
        payload: { role: "regular" },
      });
      const joined = yield* team.redeemInvite({
        token: invite.token,
        pseudo: "alice",
        client: testClient,
      });
      const alice = yield* sessions.verify(joined.accessToken);
      const threadId = ThreadId.make("mcp-snooze-thread");
      yield* team.recordThreadCreated({ sessionId: owner.sessionId, threadId, locked: true });
      yield* team.followThread({ sessionId: alice.sessionId, payload: { threadId } });

      const snoozedUntil = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 }));
      expect(
        yield* withClientCaller(
          alice.sessionId,
          TeamMcpAccess.interceptThreadSnooze({
            type: "thread.snooze",
            commandId: CommandId.make("mcp-snooze"),
            threadId,
            snoozedUntil,
          }),
        ),
      ).toBe(true);
      expect(
        yield* withClientCaller(alice.sessionId, TeamMcpAccess.loadThreadSnoozes([threadId])),
      ).toEqual([expect.objectContaining({ threadId, snoozedUntil })]);
      expect(
        yield* withClientCaller(owner.sessionId, TeamMcpAccess.loadThreadSnoozes([threadId])),
      ).toEqual([]);
      expect(
        yield* withClientCaller(
          alice.sessionId,
          TeamMcpAccess.interceptThreadSnooze({
            type: "thread.unsnooze",
            commandId: CommandId.make("mcp-unsnooze"),
            threadId,
            reason: "user",
          }),
        ),
      ).toBe(true);
      expect(
        yield* withClientCaller(alice.sessionId, TeamMcpAccess.loadThreadSnoozes([threadId])),
      ).toEqual([expect.objectContaining({ threadId, snoozedUntil: null })]);
    }).pipe(Effect.provide(makeTeamLayer())),
  );

  it.effect(
    "binds MCP credentials to actingMemberId and enforces team RBAC, Views, Locks, creator-only Send now, Interrupt, and immutable child inheritance",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const repo = yield* TeamRepository.TeamRepository;
        const sessions = yield* SessionStore.SessionStore;
        const mcpRegistry = yield* McpSessionRegistry.McpSessionRegistry;
        const sql = yield* SqlClient.SqlClient;

        const aliceSession = yield* sessions.issue({ subject: "owner-mcp" });
        const init = yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "MCP Team", ownerPseudo: "alice" },
        });
        const inviteAndJoin = (role: "modo" | "regular", pseudo: string) =>
          Effect.gen(function* () {
            const invite = yield* team.createInvite({
              sessionId: aliceSession.sessionId,
              payload: { role, prefilledPseudo: pseudo },
            });
            const redeemed = yield* team.redeemInvite({
              token: invite.token,
              pseudo,
              client: testClient,
            });
            const verified = yield* sessions.verify(redeemed.accessToken);
            return { member: redeemed.member, sessionId: verified.sessionId };
          });

        const charlie = yield* inviteAndJoin("modo", "charlie");
        const bob = yield* inviteAndJoin("regular", "bob");

        // Create restricted "Staff Only" and read-only "Announcements" views.
        const staffOnly = yield* team.createView({
          sessionId: aliceSession.sessionId,
          payload: {
            name: "Staff Only",
            readRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
            postRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
          },
        });
        const announcements = yield* team.createView({
          sessionId: aliceSession.sessionId,
          payload: {
            name: "Announcements",
            readRule: { roles: ["owner", "admin", "modo", "regular"], memberIds: [] },
            postRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
          },
        });

        const aliceDefaultThread = ThreadId.make("thread-mcp-alice-default");
        const aliceStaffThread = ThreadId.make("thread-mcp-alice-staff");
        const aliceAnnouncementsThread = ThreadId.make("thread-mcp-alice-announce");
        const bobThread = ThreadId.make("thread-mcp-bob");
        const bobActiveRunId = RunId.make("run-mcp-bob-active");
        const aliceActiveRunId = RunId.make("run-mcp-alice-active");

        yield* team.recordThreadCreated({
          sessionId: aliceSession.sessionId,
          threadId: aliceDefaultThread,
        });
        yield* team.recordTurnAuthored({
          sessionId: aliceSession.sessionId,
          threadId: aliceDefaultThread,
          turnId: aliceActiveRunId,
        });
        yield* team.recordThreadCreated({
          sessionId: aliceSession.sessionId,
          threadId: aliceStaffThread,
          viewId: staffOnly.id,
        });
        yield* team.recordThreadCreated({
          sessionId: aliceSession.sessionId,
          threadId: aliceAnnouncementsThread,
          viewId: announcements.id,
        });
        yield* team.recordThreadCreated({
          sessionId: bob.sessionId,
          threadId: bobThread,
        });
        yield* team.recordTurnAuthored({
          sessionId: bob.sessionId,
          threadId: bobThread,
          turnId: bobActiveRunId,
        });

        // Register active runs in projection so active-turn-author checks work accurately.
        for (const [runId, threadId] of [
          [aliceActiveRunId, aliceDefaultThread],
          [bobActiveRunId, bobThread],
        ] as const) {
          yield* sql`
            INSERT INTO orchestration_v2_projection_runs (
              run_id, thread_id, ordinal, provider, provider_thread_id,
              status, requested_at, completed_at, payload_json
            ) VALUES (
              ${runId}, ${threadId}, 1, 'codex', NULL,
              'running', '2026-01-01T00:00:01.000Z', NULL,
              ${JSON.stringify({ id: runId, threadId, status: "running" })}
            )
          `;
        }

        // 1. McpSessionRegistry issues member-bound credentials and preserves actingMemberId on resolve.
        const bobCred = yield* mcpRegistry.issue({
          threadId: aliceDefaultThread,
          providerInstanceId: ProviderInstanceId.make("codex"),
          actingMemberId: bob.member.id,
        });
        const bobCaller = yield* mcpRegistry.resolve(
          bobCred.config.authorizationHeader.replace(/^Bearer\s+/, ""),
        );
        expect(bobCaller?.thread.actingMemberId).toBe(bob.member.id);

        const aliceCred = yield* mcpRegistry.issue({
          threadId: bobThread,
          providerInstanceId: ProviderInstanceId.make("codex"),
          actingMemberId: init.owner.id,
        });
        const aliceCaller = yield* mcpRegistry.resolve(
          aliceCred.config.authorizationHeader.replace(/^Bearer\s+/, ""),
        );
        expect(aliceCaller?.thread.actingMemberId).toBe(init.owner.id);

        // 2. Agent running Bob's turn on Alice's thread obeys BOB's permissions (never Alice's!).
        const bobReadStaffExit = yield* Effect.exit(
          withThreadCaller(bobCaller!, TeamMcpAccess.assertCanReadThread(aliceStaffThread)),
        );
        expect(bobReadStaffExit._tag).toBe("Failure");
        if (bobReadStaffExit._tag === "Failure") {
          expect(Cause.squash(bobReadStaffExit.cause)).toMatchObject({
            _tag: "OrchestratorMcpFailure",
            code: "capability_denied",
          });
        }

        const bobFiltered = yield* withThreadCaller(
          bobCaller!,
          TeamMcpAccess.filterReadableThreadIds([
            aliceDefaultThread,
            aliceStaffThread,
            aliceAnnouncementsThread,
            bobThread,
          ]),
        );
        expect(bobFiltered.has(aliceStaffThread)).toBe(false);
        expect(bobFiltered.has(aliceDefaultThread)).toBe(true);
        expect(bobFiltered.has(aliceAnnouncementsThread)).toBe(true);
        expect(bobFiltered.has(bobThread)).toBe(true);

        // Bob's agent cannot post in read-only Announcements thread, cannot promote/steer Alice's thread,
        // cannot interrupt Alice's active turn, and cannot use admin/workflow/schedule tools.
        expect(
          (yield* Effect.exit(
            withThreadCaller(
              bobCaller!,
              TeamMcpAccess.assertCanPostInThread(aliceAnnouncementsThread),
            ),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            withThreadCaller(
              bobCaller!,
              TeamMcpAccess.assertCanPromoteQueuedRun(aliceDefaultThread),
            ),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            withThreadCaller(
              bobCaller!,
              TeamMcpAccess.assertCanSteerActiveTurn(aliceDefaultThread),
            ),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            withThreadCaller(
              bobCaller!,
              TeamMcpAccess.assertCanInterruptThread(aliceDefaultThread),
            ),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(withThreadCaller(bobCaller!, TeamMcpAccess.assertIsAdmin())))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(withThreadCaller(bobCaller!, TeamMcpAccess.assertCanUseWorkflows())))
            ._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            withThreadCaller(bobCaller!, TeamMcpAccess.assertCanUseScheduledTasks()),
          ))._tag,
        ).toBe("Failure");

        // 3. Immutable actingMemberId propagation to delegated/launched child threads:
        //    Bob's turn on Alice's thread spawns a child -> child creator is BOB (not Alice!),
        //    and child inherits parent's View (never widens).
        const bobChildFromAlice = ThreadId.make("thread-mcp-child-bob");
        const childAuth = yield* withThreadCaller(
          bobCaller!,
          TeamMcpAccess.authorizeChildThreadCreation({
            sourceThreadId: aliceDefaultThread,
          }),
        );
        expect(Option.isSome(childAuth)).toBe(true);
        const childAuthVal = Option.getOrThrow(childAuth);
        expect(childAuthVal.memberId).toBe(bob.member.id);
        expect(childAuthVal.inheritedViewId).toBe(init.team.defaultViewId);
        yield* childAuthVal.teamService.prepareThreadInheritedFromParent({
          parentThreadId: aliceDefaultThread,
          threadId: bobChildFromAlice,
          creatorMemberId: childAuthVal.memberId!,
        });
        const childAttr = Option.getOrThrow(yield* repo.getThreadAttribution(bobChildFromAlice));
        expect(childAttr.creatorMemberId).toBe(bob.member.id);
        expect(childAttr.viewId).toBe(init.team.defaultViewId);

        // 4. Alice (owner) acting via MCP on Bob's thread:
        //    - CANNOT Send now / promote queued run on Bob's thread (creator-only!)
        //    - CAN Interrupt Bob's active turn AND fires the Milestone 7 interrupt hook!
        expect(
          (yield* Effect.exit(
            withThreadCaller(aliceCaller!, TeamMcpAccess.assertCanPromoteQueuedRun(bobThread)),
          ))._tag,
        ).toBe("Failure");
        yield* withThreadCaller(aliceCaller!, TeamMcpAccess.assertCanInterruptThread(bobThread));

        const hookEvents: Array<TeamService.TeamTurnInterruptEvent> = [];
        yield* team.registerTurnInterruptHook((event) =>
          Effect.sync(() => {
            hookEvents.push(event);
          }),
        );
        yield* withThreadCaller(
          aliceCaller!,
          TeamMcpAccess.notifyTurnInterruptedByCaller({
            threadId: bobThread,
            runId: bobActiveRunId,
            reason: "interrupt",
          }),
        );
        expect(hookEvents).toEqual([
          {
            threadId: bobThread,
            runId: bobActiveRunId,
            actorMemberId: init.owner.id,
            activeTurnAuthorMemberId: bob.member.id,
            reason: "interrupt",
          },
        ]);

        // 5. External OAuth MCP client (session-bound) obeys identical team RBAC, and unbound tokens fail closed.
        const unboundThreadToken = yield* mcpRegistry.issue({
          threadId: aliceDefaultThread,
          providerInstanceId: ProviderInstanceId.make("codex"),
        });
        const unboundThreadCaller = yield* mcpRegistry.resolve(
          unboundThreadToken.config.authorizationHeader.replace(/^Bearer\s+/, ""),
        );
        expect(unboundThreadCaller).toBeDefined();
        expect(
          (yield* Effect.exit(
            withThreadCaller(
              unboundThreadCaller!,
              TeamMcpAccess.assertCanReadThread(aliceDefaultThread),
            ),
          ))._tag,
        ).toBe("Failure");
        expect(yield* withThreadCaller(unboundThreadCaller!, TeamMcpAccess.canUseWorkflows())).toBe(
          false,
        );
        expect(yield* withThreadCaller(bobCaller!, TeamMcpAccess.canUseWorkflows())).toBe(false);
        expect(yield* withThreadCaller(aliceCaller!, TeamMcpAccess.canUseWorkflows())).toBe(true);

        const unboundSession = yield* sessions.issue({ subject: "unbound-oauth" });
        expect(
          yield* withClientCaller(unboundSession.sessionId, TeamMcpAccess.canUseWorkflows()),
        ).toBe(false);
        expect(
          (yield* Effect.exit(
            withClientCaller(
              unboundSession.sessionId,
              TeamMcpAccess.assertActiveMemberIfTeamConfigured,
            ),
          ))._tag,
        ).toBe("Failure");
        // Modo (Charlie) can interrupt Bob's unlocked readable thread via MCP, cannot respond to runtime requests,
        // and cannot interrupt once the thread is locked.
        yield* withClientCaller(
          charlie.sessionId,
          TeamMcpAccess.assertCanInterruptThread(bobThread),
        );
        expect(
          (yield* Effect.exit(
            withClientCaller(
              charlie.sessionId,
              TeamMcpAccess.assertCanRespondToRuntimeRequest(bobThread),
            ),
          ))._tag,
        ).toBe("Failure");
        yield* team.setThreadLocked({
          sessionId: aliceSession.sessionId,
          payload: { threadId: bobThread, locked: true },
        });
        expect(
          (yield* Effect.exit(
            withClientCaller(charlie.sessionId, TeamMcpAccess.assertCanInterruptThread(bobThread)),
          ))._tag,
        ).toBe("Failure");
        yield* team.setThreadLocked({
          sessionId: aliceSession.sessionId,
          payload: { threadId: bobThread, locked: false },
        });
        yield* withClientCaller(
          charlie.sessionId,
          TeamMcpAccess.assertCanReadThread(aliceStaffThread),
        );

        // 6. Suspending Bob immediately invalidates his in-flight MCP actingMemberId calls.
        yield* team.updateMemberStatus({
          sessionId: aliceSession.sessionId,
          payload: { memberId: bob.member.id, status: "suspended" },
        });
        expect(
          (yield* Effect.exit(
            withThreadCaller(bobCaller!, TeamMcpAccess.assertActiveMemberIfTeamConfigured),
          ))._tag,
        ).toBe("Failure");
      }).pipe(Effect.provide(makeTeamLayer())),
  );

  it.effect(
    "enforces --team-hub-only control-plane mode: advertises capability, refuses local terminal PTY spawns, and auto-enables runner peer links",
    () =>
      Effect.gen(function* () {
        const env = yield* ServerEnvironment.ServerEnvironment;
        const descriptor = yield* env.getDescriptor;
        expect(descriptor.capabilities.teamHubOnly).toBe(true);

        // TerminalManager refuses PTY spawns in --team-hub-only mode without ever touching the PTY adapter.
        let ptySpawnCount = 0;
        const fakePtyAdapter = PtyAdapter.PtyAdapter.of({
          spawn: () => {
            ptySpawnCount += 1;
            return Effect.die("PTY spawn must never be called in --team-hub-only mode");
          },
        });
        const config = yield* ServerConfig.ServerConfig;
        const terminalExit = yield* Effect.scoped(
          Effect.gen(function* () {
            const manager = yield* TerminalManager.makeWithOptions({
              logsDir: config.terminalLogsDir,
              ptyAdapter: fakePtyAdapter,
              teamHubOnly: true,
            });
            return yield* manager.open({
              threadId: ThreadId.make("thread-hub-only"),
              terminalId: "default",
              cwd: process.cwd(),
              cols: 80,
              rows: 24,
            });
          }),
        ).pipe(Effect.provide(ProcessRunner.layer), Effect.exit);
        expect(terminalExit._tag).toBe("Failure");
        expect(ptySpawnCount).toBe(0);
        if (terminalExit._tag === "Failure") {
          const error = Cause.squash(terminalExit.cause) as { readonly cause?: unknown };
          expect(String(error.cause ?? error)).toContain("--team-hub-only");
        }

        // Hub-only MCP local execution guard refuses spawning local agent runs.
        const mcpHubExit = yield* Effect.exit(assertLocalAgentMcpExecutionAllowed);
        expect(mcpHubExit._tag).toBe("Failure");

        // PeerLinks automatically enables peer linking when teamHubOnly is active.
        const peerLayer = PeerLinks.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ServerSettings.layerTest({ linkedEnvironmentsEnabled: false }),
              FetchHttpClient.layer,
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const peerLinks = yield* PeerLinks.PeerLinks;
          expect(yield* peerLinks.enabled).toBe(true);
        }).pipe(Effect.provide(peerLayer));
      }).pipe(Effect.provide(makeTeamLayer({ teamHubOnly: true }))),
  );

  it.effect(
    "enforces Milestone 5 per-environment ACLs and local-execution boundary across member-bound MCP tools",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const sessions = yield* SessionStore.SessionStore;

        const aliceSession = yield* sessions.issue({ subject: "alice-mcp-m5" });
        yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "MCP M5 Team", ownerPseudo: "alice" },
        });
        const bobInvite = yield* team.createInvite({
          sessionId: aliceSession.sessionId,
          payload: { role: "regular", prefilledPseudo: "bob" },
        });
        const bobRedeemed = yield* team.redeemInvite({
          token: bobInvite.token,
          pseudo: "bob",
          client: testClient,
        });
        const bobSession = yield* sessions.verify(bobRedeemed.accessToken);

        // Attach a restricted remote environment (owner/admin only).
        const restrictedEnvId = EnvironmentId.make("env-restricted-mcp");
        yield* team.attachEnvironment({
          sessionId: aliceSession.sessionId,
          payload: {
            environmentId: restrictedEnvId,
            name: "Restricted GPU",
            accessRule: { roles: ["owner", "admin"], memberIds: [] },
          },
        });
        const aliceState = yield* team.getState(aliceSession.sessionId);
        const defaultEnvId = (aliceState.environments ?? []).find(
          (e) => e.isDefault,
        )!.environmentId;

        // Regular Bob's MCP filter hides restrictedEnvId and assertCanAccessEnvironment denies it.
        const bobAccessible = yield* withClientCaller(
          bobSession.sessionId,
          TeamMcpAccess.filterAccessibleEnvironmentIds([defaultEnvId, restrictedEnvId]),
        );
        expect(bobAccessible.has(defaultEnvId)).toBe(true);
        expect(bobAccessible.has(restrictedEnvId)).toBe(false);
        expect(
          (yield* Effect.exit(
            withClientCaller(
              bobSession.sessionId,
              TeamMcpAccess.assertCanAccessEnvironment(restrictedEnvId),
            ),
          ))._tag,
        ).toBe("Failure");

        // Owner Alice's MCP caller CAN access restrictedEnvId.
        yield* withClientCaller(
          aliceSession.sessionId,
          TeamMcpAccess.assertCanAccessEnvironment(restrictedEnvId),
        );

        // Bob syncs a local-environment thread; even owner Alice's MCP caller is blocked from executing on it!
        const mcpProjectId = ProjectId.make("proj-mcp-m5");
        yield* team.assignProject({
          sessionId: aliceSession.sessionId,
          payload: { projectId: mcpProjectId },
        });
        const bobLocalThreadId = ThreadId.make("thread-bob-local-mcp");
        yield* team.syncLocalThread({
          sessionId: bobSession.sessionId,
          payload: {
            threadId: bobLocalThreadId,
            projectId: mcpProjectId,
            executionEnvironmentId: EnvironmentId.make("env-bob-laptop-mcp"),
            executionEnvironmentLabel: "Bob Laptop",
            title: "Bob Local MCP Test",
            branch: null,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5",
              options: [],
            },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            runs: [],
            messages: [],
          },
        });
        // Alice can READ Bob's local-synced thread via MCP...
        yield* withClientCaller(
          aliceSession.sessionId,
          TeamMcpAccess.assertCanReadThread(bobLocalThreadId),
        );
        // ...but CANNOT post, steer, or interrupt on it via MCP!
        expect(
          (yield* Effect.exit(
            withClientCaller(
              aliceSession.sessionId,
              TeamMcpAccess.assertCanPostInThread(bobLocalThreadId),
            ),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            withClientCaller(
              aliceSession.sessionId,
              TeamMcpAccess.assertCanInterruptThread(bobLocalThreadId),
            ),
          ))._tag,
        ).toBe("Failure");
      }).pipe(Effect.provide(makeTeamLayer())),
  );

  it.effect(
    "enforces Milestone 8 synthetic team-automation MCP principal (minimal vs elevated) and immutable propagation",
    () =>
      Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const sessions = yield* SessionStore.SessionStore;
        const mcpRegistry = yield* McpSessionRegistry.McpSessionRegistry;
        const sql = yield* SqlClient.SqlClient;

        const aliceSession = yield* sessions.issue({ subject: "alice-mcp-m8" });
        const init = yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "MCP M8 Team", ownerPseudo: "alice" },
        });
        const aliceState = yield* team.getState(aliceSession.sessionId);
        const defaultEnvId = (aliceState.environments ?? []).find(
          (e) => e.isDefault,
        )!.environmentId;

        const adminView = yield* team.createView({
          sessionId: aliceSession.sessionId,
          payload: {
            name: "Admin Secret",
            readRule: { roles: ["owner", "admin"], memberIds: [] },
            postRule: { roles: ["owner", "admin"], memberIds: [] },
          },
        });
        const scopedProjectId = ProjectId.make("proj-m8-scoped");
        const otherProjectId = ProjectId.make("proj-m8-other");
        const adminThreadId = ThreadId.make("thread-m8-admin-view");
        const scopedThreadId = ThreadId.make("thread-m8-scoped-view");
        const otherProjectThreadId = ThreadId.make("thread-m8-other-proj");
        const now = "2026-01-01T00:00:00.000Z";

        // Seed minimal orchestration_v2_projection_threads rows so getThreadProjectIdInProjection resolves projectIds.
        for (const [tid, pid] of [
          [adminThreadId, scopedProjectId],
          [scopedThreadId, scopedProjectId],
          [otherProjectThreadId, otherProjectId],
        ] as const) {
          yield* sql`
            INSERT OR IGNORE INTO orchestration_v2_projection_threads (
              thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
              active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
            ) VALUES (
              ${tid}, ${pid}, ${tid}, 'devReplay', 'full-access', 'default',
              NULL, ${now}, ${now}, NULL, NULL, '{}'
            )
          `;
        }

        yield* team.recordThreadCreated({
          sessionId: aliceSession.sessionId,
          threadId: adminThreadId,
          viewId: adminView.id,
        });
        yield* team.recordThreadCreated({
          sessionId: aliceSession.sessionId,
          threadId: scopedThreadId,
          viewId: init.team.defaultViewId,
        });
        yield* team.recordThreadCreated({
          sessionId: aliceSession.sessionId,
          threadId: otherProjectThreadId,
          viewId: init.team.defaultViewId,
        });

        const minimalPrincipal = {
          taskId: ScheduledTaskId.make("task-m8-mcp-min"),
          teamId: init.team.id,
          projectId: scopedProjectId,
          environmentId: defaultEnvId,
          viewId: init.team.defaultViewId,
          mcpAccessLevel: "minimal" as const,
        };
        const elevatedPrincipal = {
          ...minimalPrincipal,
          taskId: ScheduledTaskId.make("task-m8-mcp-elev"),
          mcpAccessLevel: "elevated" as const,
        };

        const minCred = yield* mcpRegistry.issue({
          threadId: scopedThreadId,
          providerInstanceId: ProviderInstanceId.make("devReplay"),
          teamAutomation: minimalPrincipal,
        });
        const minCaller = yield* mcpRegistry.resolve(
          minCred.config.authorizationHeader.replace(/^Bearer\s+/, ""),
        );
        expect(minCaller?.thread.teamAutomation).toEqual(minimalPrincipal);

        // Minimal automation CANNOT read admin-only view OR threads in another project,
        // CAN read threads inside its own (projectId, environmentId, viewId).
        const minReadable = yield* withThreadCaller(
          minCaller!,
          TeamMcpAccess.filterReadableThreadIds([
            adminThreadId,
            scopedThreadId,
            otherProjectThreadId,
          ]),
        );
        expect(minReadable.has(scopedThreadId)).toBe(true);
        expect(minReadable.has(adminThreadId)).toBe(false);
        expect(minReadable.has(otherProjectThreadId)).toBe(false);

        expect(
          (yield* Effect.exit(
            withThreadCaller(minCaller!, TeamMcpAccess.assertCanReadThread(adminThreadId)),
          ))._tag,
        ).toBe("Failure");

        // Minimal automation CANNOT launch a child thread in another project.
        expect(
          (yield* Effect.exit(
            withThreadCaller(
              minCaller!,
              TeamMcpAccess.authorizeChildThreadCreation({
                sourceThreadId: scopedThreadId,
                projectId: otherProjectId,
              }),
            ),
          ))._tag,
        ).toBe("Failure");

        // Minimal automation launching inside its own scope propagates teamAutomation immutably with memberId = null.
        const childAuthOpt = yield* withThreadCaller(
          minCaller!,
          TeamMcpAccess.authorizeChildThreadCreation({
            sourceThreadId: scopedThreadId,
            projectId: scopedProjectId,
          }),
        );
        expect(Option.isSome(childAuthOpt)).toBe(true);
        const childAuth = Option.getOrThrow(childAuthOpt);
        expect(childAuth.memberId).toBeNull();
        expect(childAuth.teamAutomation).toEqual(minimalPrincipal);

        // Minimal automation CANNOT access other projects or Scratch, CAN access its own project.
        yield* withThreadCaller(minCaller!, TeamMcpAccess.assertCanAccessProject(scopedProjectId));
        expect(
          (yield* Effect.exit(
            withThreadCaller(minCaller!, TeamMcpAccess.assertCanAccessProject(otherProjectId)),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            withThreadCaller(minCaller!, TeamMcpAccess.assertCanUseScratchProject()),
          ))._tag,
        ).toBe("Failure");
        expect(
          Option.getOrNull(
            yield* withThreadCaller(minCaller!, TeamMcpAccess.getMinimalAutomationProjectId()),
          ),
        ).toBe(scopedProjectId);

        // Minimal automation configured on an admin-only View, admin-only Environment, and locked
        // team thread CAN still read/post/execute/spawn on its OWN thread & scope, while remaining
        // blocked from unrelated locked human threads or other views/projects.
        const envRecord = (aliceState.environments ?? []).find(
          (e) => e.environmentId === defaultEnvId,
        )!;
        yield* team.updateEnvironment({
          sessionId: aliceSession.sessionId,
          payload: {
            environmentId: envRecord.environmentId,
            accessRule: { roles: ["owner", "admin"], memberIds: [] },
          },
        });
        const lockedAdminAutoThreadId = ThreadId.make("thread-m8-locked-admin-auto");
        const lockedHumanAdminThreadId = ThreadId.make("thread-m8-locked-human-admin");
        for (const tid of [lockedAdminAutoThreadId, lockedHumanAdminThreadId]) {
          yield* sql`
            INSERT OR IGNORE INTO orchestration_v2_projection_threads (
              thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
              active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
            ) VALUES (
              ${tid}, ${scopedProjectId}, ${tid}, 'devReplay', 'full-access', 'default',
              NULL, ${now}, ${now}, NULL, NULL, '{}'
            )
          `;
        }
        const adminMinTaskId = ScheduledTaskId.make("task-m8-admin-min");
        yield* team.saveScheduledTaskMeta({
          taskId: adminMinTaskId,
          teamId: init.team.id,
          environmentId: defaultEnvId,
          viewId: adminView.id,
          locked: true,
          mcpAccessLevel: "minimal",
          actorMemberId: init.owner.id,
        });
        yield* team.prepareTeamAutomationThreadAttribution({
          taskId: adminMinTaskId,
          threadId: lockedAdminAutoThreadId,
          projectId: scopedProjectId,
        });
        yield* team.recordThreadCreated({
          sessionId: aliceSession.sessionId,
          threadId: lockedHumanAdminThreadId,
          viewId: adminView.id,
          locked: true,
        });
        const adminMinPrincipal = {
          taskId: adminMinTaskId,
          teamId: init.team.id,
          projectId: scopedProjectId,
          environmentId: defaultEnvId,
          viewId: adminView.id,
          mcpAccessLevel: "minimal" as const,
        };
        const adminMinCred = yield* mcpRegistry.issue({
          threadId: lockedAdminAutoThreadId,
          providerInstanceId: ProviderInstanceId.make("devReplay"),
          teamAutomation: adminMinPrincipal,
        });
        const adminMinCaller = yield* mcpRegistry.resolve(
          adminMinCred.config.authorizationHeader.replace(/^Bearer\s+/, ""),
        );
        yield* withThreadCaller(adminMinCaller!, TeamMcpAccess.assertCanAccessCallerThread("read"));
        yield* withThreadCaller(
          adminMinCaller!,
          TeamMcpAccess.assertCanAccessCallerThread("write"),
        );
        yield* withThreadCaller(
          adminMinCaller!,
          TeamMcpAccess.assertCanAccessEnvironment(defaultEnvId),
        );
        yield* withThreadCaller(
          adminMinCaller!,
          TeamMcpAccess.authorizeChildThreadCreation({
            sourceThreadId: lockedAdminAutoThreadId,
            projectId: scopedProjectId,
            locked: true,
          }),
        );
        // Still blocked from posting into an unrelated locked human thread in the same view,
        // and blocked from reading Default View threads outside its configured Admin view.
        expect(
          (yield* Effect.exit(
            withThreadCaller(
              adminMinCaller!,
              TeamMcpAccess.assertCanPostInThread(lockedHumanAdminThreadId),
            ),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            withThreadCaller(adminMinCaller!, TeamMcpAccess.assertCanReadThread(scopedThreadId)),
          ))._tag,
        ).toBe("Failure");

        // Elevated automation CAN read admin-only view while still attributed as team-automation (memberId = null).
        const elevCred = yield* mcpRegistry.issue({
          threadId: scopedThreadId,
          providerInstanceId: ProviderInstanceId.make("devReplay"),
          teamAutomation: elevatedPrincipal,
        });
        const elevCaller = yield* mcpRegistry.resolve(
          elevCred.config.authorizationHeader.replace(/^Bearer\s+/, ""),
        );
        const elevReadable = yield* withThreadCaller(
          elevCaller!,
          TeamMcpAccess.filterReadableThreadIds([adminThreadId, scopedThreadId]),
        );
        expect(elevReadable.has(adminThreadId)).toBe(true);
        expect(elevReadable.has(scopedThreadId)).toBe(true);
        yield* withThreadCaller(elevCaller!, TeamMcpAccess.assertCanAccessProject(otherProjectId));
        yield* withThreadCaller(elevCaller!, TeamMcpAccess.assertCanUseScratchProject());
      }).pipe(Effect.provide(makeTeamLayer())),
  );
});
