import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  TEAM_CLIENT_CAPABILITY_HEADER,
  TEAM_CLIENT_CAPABILITY_QUERY_PARAM,
  TEAM_CLIENT_CAPABILITY_VALUE,
  TeamMemberId,
  ThreadId,
  type AuthClientMetadata,
  type OrchestrationV2Command,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as TeamRepository from "./TeamRepository.ts";
import * as TeamService from "./TeamService.ts";
import {
  adaptSearchThreadsResultForUpstreamCompat,
  adaptShellSnapshotForUpstreamCompat,
  adaptShellStreamItemForUpstreamCompat,
  adaptThreadLinkMetadataForUpstreamCompat,
  adaptThreadProjectionForUpstreamCompat,
  adaptThreadStreamItemForUpstreamCompat,
  adaptThreadTitlesForUpstreamCompat,
  formatUpstreamCompatThreadTitle,
  isTeamAwareClientRequest,
  resolveTeamThreadTitlePrefix,
  stripUpstreamCompatThreadTitlePrefix,
} from "./upstreamMobileCompat.ts";

const makeTestLayer = () => {
  const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
  const configLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-team-mobile-compat-",
  }).pipe(Layer.provideMerge(platform));
  const persistence = SqlitePersistence.layerMemory.pipe(Layer.provideMerge(configLayer));
  const secretsAndPolicy = Layer.mergeAll(
    ServerSecretStore.layer,
    ManagedPolicy.layerTest(),
    ServerEnvironment.layerIdentity,
  ).pipe(Layer.provideMerge(persistence));
  const authLayer = EnvironmentAuth.layer.pipe(Layer.provideMerge(secretsAndPolicy));
  const repoLayer = TeamRepository.layer.pipe(Layer.provideMerge(authLayer));
  const teamLayer = TeamService.layer.pipe(Layer.provideMerge(repoLayer));
  return Layer.mergeAll(teamLayer, repoLayer, authLayer, secretsAndPolicy);
};

const clientMeta: AuthClientMetadata = {
  label: "Upstream iOS",
  deviceType: "mobile",
  os: "iOS",
};

const desktopClientMeta: AuthClientMetadata = {
  label: "Desktop Web",
  deviceType: "desktop",
};

const makeThreadShell = (id: ThreadId, title: string): OrchestrationV2ThreadShell =>
  ({
    id,
    projectId: ProjectId.make("project-1"),
    title,
    status: "idle",
  }) as unknown as OrchestrationV2ThreadShell;

const makeThreadProjection = (id: ThreadId, title: string): OrchestrationV2ThreadProjection =>
  ({
    thread: {
      id,
      projectId: ProjectId.make("project-1"),
      title,
      status: "idle",
    },
    runs: [],
    messages: [],
    turnItems: [],
  }) as unknown as OrchestrationV2ThreadProjection;

describe("upstreamMobileCompat pure helpers", () => {
  it("detects team-aware clients via HTTP header or WS query parameter", () => {
    expect(isTeamAwareClientRequest({ headers: {} })).toBe(false);
    expect(
      isTeamAwareClientRequest(
        { headers: { [TEAM_CLIENT_CAPABILITY_HEADER]: TEAM_CLIENT_CAPABILITY_VALUE } },
        null,
      ),
    ).toBe(true);
    expect(
      isTeamAwareClientRequest(
        { headers: {} },
        new URL(`http://127.0.0.1/ws?${TEAM_CLIENT_CAPABILITY_QUERY_PARAM}=1`),
      ),
    ).toBe(true);
    expect(
      isTeamAwareClientRequest(
        { headers: { [TEAM_CLIENT_CAPABILITY_HEADER]: "0" } },
        new URL(`http://127.0.0.1/ws?${TEAM_CLIENT_CAPABILITY_QUERY_PARAM}=0`),
      ),
    ).toBe(false);
  });

  it("formats and strips member-owned and team-owned (M8) thread title prefixes cleanly", () => {
    const memberCtx = {
      ownerKind: "member" as const,
      creatorPseudo: "alice",
      teamDisplayName: "acme",
    };
    const teamCtx = {
      ownerKind: "team" as const,
      creatorPseudo: null,
      teamDisplayName: "acme",
    };

    expect(resolveTeamThreadTitlePrefix(memberCtx)).toBe("alice");
    expect(resolveTeamThreadTitlePrefix(teamCtx)).toBe("acme");

    expect(formatUpstreamCompatThreadTitle("Fix login bug", memberCtx)).toBe(
      "alice: Fix login bug",
    );
    expect(formatUpstreamCompatThreadTitle("alice: Fix login bug", memberCtx)).toBe(
      "alice: Fix login bug",
    );
    expect(formatUpstreamCompatThreadTitle("Nightly triage", teamCtx)).toBe("acme: Nightly triage");
    expect(formatUpstreamCompatThreadTitle("acme: Nightly triage", teamCtx)).toBe(
      "acme: Nightly triage",
    );

    // Rename hygiene: strips single or repeated matching leading prefixes without touching unrelated prefixes.
    expect(stripUpstreamCompatThreadTitlePrefix("alice: Fix OAuth bug", memberCtx)).toBe(
      "Fix OAuth bug",
    );
    expect(stripUpstreamCompatThreadTitlePrefix("alice: alice: Fix OAuth bug", memberCtx)).toBe(
      "Fix OAuth bug",
    );
    expect(stripUpstreamCompatThreadTitlePrefix("ALICE:   Fix OAuth bug", memberCtx)).toBe(
      "Fix OAuth bug",
    );
    expect(stripUpstreamCompatThreadTitlePrefix("Fix OAuth bug", memberCtx)).toBe("Fix OAuth bug");
    expect(stripUpstreamCompatThreadTitlePrefix("fix: handle null", memberCtx)).toBe(
      "fix: handle null",
    );
    expect(stripUpstreamCompatThreadTitlePrefix("bob: something", memberCtx)).toBe(
      "bob: something",
    );
    expect(stripUpstreamCompatThreadTitlePrefix("alice:", memberCtx)).toBe("alice:");
    expect(stripUpstreamCompatThreadTitlePrefix("acme: Nightly triage v2", teamCtx)).toBe(
      "Nightly triage v2",
    );
  });
});

describe("upstreamMobileCompat integration", () => {
  it.effect(
    "binds member-created mobile pairing links to memberId on redeem, caps scopes, clamps on demotion, and fails closed when suspended",
    () =>
      Effect.gen(function* () {
        const teamService = yield* TeamService.TeamService;
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;

        const ownerSession = yield* sessions.issue({
          method: "browser-session-cookie",
          subject: "owner",
          scopes: AuthStandardClientScopes,
          client: desktopClientMeta,
        });
        const init = yield* teamService.initializeTeam({
          sessionId: ownerSession.sessionId,
          payload: { name: "Acme Engineering", ownerPseudo: "alice" },
        });

        // Invite Bob as regular and Dana as admin.
        const bobInvite = yield* teamService.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "regular", prefilledPseudo: "bob" },
        });
        const bobRedeemed = yield* teamService.redeemInvite({
          token: bobInvite.token,
          pseudo: "bob",
          client: desktopClientMeta,
        });
        const bobDesktopSession = yield* sessions.verify(bobRedeemed.accessToken);

        const danaInvite = yield* teamService.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "admin", prefilledPseudo: "dana" },
        });
        const danaRedeemed = yield* teamService.redeemInvite({
          token: danaInvite.token,
          pseudo: "dana",
          client: desktopClientMeta,
        });
        const danaDesktopSession = yield* sessions.verify(danaRedeemed.accessToken);

        // 1. Bob (regular) cannot mint a pairing link with broader scopes than his session.
        const widenedExit = yield* Effect.exit(
          teamService.createMobilePairingLink({
            sessionId: bobDesktopSession.sessionId,
            callerScopes: bobDesktopSession.scopes,
            payload: { scopes: [AuthAccessWriteScope] },
            serverAuth,
          }),
        );
        expect(Exit.isFailure(widenedExit)).toBe(true);

        // 2. Bob creates a standard mobile pairing link and lists it.
        const bobLink = yield* teamService.createMobilePairingLink({
          sessionId: bobDesktopSession.sessionId,
          callerScopes: bobDesktopSession.scopes,
          payload: { label: "Bob iPhone" },
          serverAuth,
        });
        expect(bobLink.scopes).not.toContain(AuthAccessWriteScope);

        const bobPending = yield* teamService.listMyMobilePairingLinks({
          sessionId: bobDesktopSession.sessionId,
          serverAuth,
        });
        expect(bobPending.map((l) => l.id)).toContain(bobLink.id);

        // Alice cannot revoke Bob's link via revokeMyMobilePairingLink.
        const aliceRevokeBobExit = yield* Effect.exit(
          teamService.revokeMyMobilePairingLink({
            sessionId: ownerSession.sessionId,
            payload: { id: bobLink.id },
            serverAuth,
          }),
        );
        expect(Exit.isFailure(aliceRevokeBobExit)).toBe(true);

        // 3. Unmodified mobile client redeems Bob's pairing link via standard /oauth/token flow.
        const mobileToken = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          bobLink.credential,
          undefined,
          clientMeta,
        );
        const mobileSession = yield* sessions.verify(mobileToken.access_token);
        const mobileMemberId = yield* teamService.resolveMemberIdForSession(
          mobileSession.sessionId,
        );
        expect(Option.getOrNull(mobileMemberId)).toBe(bobRedeemed.member.id);
        expect(mobileSession.scopes).not.toContain(AuthAccessWriteScope);

        // 4. Dana (admin) creates a pairing link, gets demoted to regular before redeem -> scopes clamped!
        const danaLink = yield* teamService.createMobilePairingLink({
          sessionId: danaDesktopSession.sessionId,
          callerScopes: danaDesktopSession.scopes,
          payload: { label: "Dana iPad" },
          serverAuth,
        });
        expect(danaLink.scopes).toContain(AuthAccessWriteScope);

        yield* teamService.updateMemberRole({
          sessionId: ownerSession.sessionId,
          payload: { memberId: danaRedeemed.member.id, role: "regular" },
        });
        const danaMobileToken = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          danaLink.credential,
          undefined,
          clientMeta,
        );
        const danaMobileSession = yield* sessions.verify(danaMobileToken.access_token);
        expect(danaMobileSession.scopes).not.toContain(AuthAccessWriteScope);
        expect(
          Option.getOrNull(
            yield* teamService.resolveMemberIdForSession(danaMobileSession.sessionId),
          ),
        ).toBe(danaRedeemed.member.id);

        // 5. Bob creates a second pairing link, then Alice suspends Bob -> link is revoked and fails closed!
        const bobLink2 = yield* teamService.createMobilePairingLink({
          sessionId: bobDesktopSession.sessionId,
          callerScopes: bobDesktopSession.scopes,
          payload: { label: "Bob Backup Phone" },
          serverAuth,
        });
        yield* teamService.updateMemberStatus({
          sessionId: ownerSession.sessionId,
          payload: { memberId: bobRedeemed.member.id, status: "suspended" },
        });
        const suspendedRedeemExit = yield* Effect.exit(
          serverAuth.exchangeBootstrapCredentialForAccessToken(
            bobLink2.credential,
            undefined,
            clientMeta,
          ),
        );
        expect(Exit.isFailure(suspendedRedeemExit)).toBe(true);

        // 6. Browser session redemption also binds team_session_meta to creator memberId.
        const aliceLink = yield* teamService.createMobilePairingLink({
          sessionId: ownerSession.sessionId,
          callerScopes: ownerSession.scopes,
          payload: { label: "Alice Safari" },
          serverAuth,
        });
        const browserResult = yield* serverAuth.createBrowserSession(
          aliceLink.credential,
          clientMeta,
        );
        const browserSession = yield* sessions.verify(browserResult.sessionToken);
        expect(
          Option.getOrNull(yield* teamService.resolveMemberIdForSession(browserSession.sessionId)),
        ).toBe(init.owner.id);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "enforces mobile visibility preference, dynamic title prefixing, rename stripping, and clear RBAC errors without mutating SQLite",
    () =>
      Effect.gen(function* () {
        const teamService = yield* TeamService.TeamService;
        const sessions = yield* SessionStore.SessionStore;
        const repo = yield* TeamRepository.TeamRepository;
        const sql = yield* SqlClient.SqlClient;

        const aliceSession = yield* sessions.issue({
          method: "browser-session-cookie",
          subject: "owner",
          scopes: AuthStandardClientScopes,
          client: desktopClientMeta,
        });
        const init = yield* teamService.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "Acme", ownerPseudo: "alice" },
        });
        const bobInvite = yield* teamService.createInvite({
          sessionId: aliceSession.sessionId,
          payload: { role: "regular", prefilledPseudo: "bob" },
        });
        const bobRedeemed = yield* teamService.redeemInvite({
          token: bobInvite.token,
          pseudo: "bob",
          client: desktopClientMeta,
        });
        const bobSession = yield* sessions.verify(bobRedeemed.accessToken);

        // Create an admin-only view.
        const adminView = yield* teamService.createView({
          sessionId: aliceSession.sessionId,
          payload: {
            name: "Admin Only",
            readRule: { roles: ["owner", "admin"], memberIds: [] },
            postRule: { roles: ["owner", "admin"], memberIds: [] },
          },
        });

        const aliceDefaultThread = ThreadId.make("thread-alice-default");
        const aliceLockedThread = ThreadId.make("thread-alice-locked");
        const aliceAdminThread = ThreadId.make("thread-alice-admin");
        const aliceLocalThread = ThreadId.make("thread-alice-local");
        const bobThread = ThreadId.make("thread-bob-own");

        // Record attributions.
        yield* teamService.recordThreadCreated({
          sessionId: aliceSession.sessionId,
          threadId: aliceDefaultThread,
        });
        yield* teamService.recordThreadCreated({
          sessionId: aliceSession.sessionId,
          threadId: aliceLockedThread,
          locked: true,
        });
        yield* teamService.recordThreadCreated({
          sessionId: aliceSession.sessionId,
          threadId: aliceAdminThread,
          viewId: adminView.id,
        });
        yield* teamService.recordThreadCreated({
          sessionId: bobSession.sessionId,
          threadId: bobThread,
        });
        // Seed a local-synced thread attributed to Alice.
        yield* repo.recordThreadAttribution({
          threadId: aliceLocalThread,
          teamId: init.team.id,
          creatorMemberId: init.owner.id,
          viewId: init.team.defaultViewId,
          locked: false,
          lockedByMemberId: null,
          executionEnvironmentId: EnvironmentId.make("env-alice-laptop"),
          executionEnvironmentLabel: "alice's laptop",
          isLocalSynced: true,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });

        // Insert a dummy projection row so followThread finds aliceDefaultThread.
        yield* sql`
          INSERT OR IGNORE INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json, scripts_json,
            created_at, updated_at, deleted_at
          ) VALUES (
            'project-1', 'Demo', '/tmp/demo', '{}', '[]',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
          )
        `;
        yield* sql`
          INSERT OR IGNORE INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
            branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at
          ) VALUES (
            ${aliceDefaultThread}, 'project-1', 'Deploy fix', '{}', 'full-access', 'default',
            NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
          )
        `;

        const snapshot = {
          schemaVersion: 1,
          snapshotSequence: 1,
          projects: [],
          threads: [
            makeThreadShell(aliceDefaultThread, "Deploy fix"),
            makeThreadShell(aliceLockedThread, "Release lock"),
            makeThreadShell(aliceAdminThread, "Secret roadmap"),
            makeThreadShell(bobThread, "Bob task"),
          ],
          archivedThreads: [],
        } as unknown as OrchestrationV2ShellSnapshot;

        // 1. Default visibility (owned_and_followed): Bob's upstream mobile sees ONLY his own thread, prefixed!
        const mobileSnapDefault = yield* adaptShellSnapshotForUpstreamCompat(
          teamService,
          bobSession.sessionId,
          snapshot,
          true,
        );
        expect(mobileSnapDefault.threads.map((t) => [t.id, t.title])).toEqual([
          [bobThread, "bob: Bob task"],
        ]);

        // Forked client (upstreamCompat=false) sees all readable threads with raw unprefixed titles!
        const forkedSnap = yield* adaptShellSnapshotForUpstreamCompat(
          teamService,
          bobSession.sessionId,
          snapshot,
          false,
        );
        expect(forkedSnap.threads.map((t) => [t.id, t.title])).toEqual([
          [aliceDefaultThread, "Deploy fix"],
          [aliceLockedThread, "Release lock"],
          [bobThread, "Bob task"],
        ]);

        // Live shell item for Alice's unfollowed thread is dropped for Bob's mobile in owned_and_followed mode.
        const unfollowedLive = yield* adaptShellStreamItemForUpstreamCompat(
          teamService,
          bobSession.sessionId,
          {
            kind: "thread.updated",
            sequence: 2,
            thread: makeThreadShell(aliceDefaultThread, "Deploy fix"),
          } as OrchestrationV2ShellStreamItem,
          true,
        );
        expect(unfollowedLive).toBeNull();

        // 2. Bob follows Alice's default thread -> immediately visible and prefixed on mobile!
        yield* teamService.followThread({
          sessionId: bobSession.sessionId,
          payload: { threadId: aliceDefaultThread },
        });
        const mobileSnapFollowed = yield* adaptShellSnapshotForUpstreamCompat(
          teamService,
          bobSession.sessionId,
          snapshot,
          true,
        );
        expect(mobileSnapFollowed.threads.map((t) => [t.id, t.title])).toEqual([
          [aliceDefaultThread, "alice: Deploy fix"],
          [bobThread, "bob: Bob task"],
        ]);

        // 3. Bob switches visibility to all_accessible -> sees unlocked + locked default-view threads, STILL NOT admin-only!
        const updatedBob = yield* teamService.updateMyMobileVisibility({
          sessionId: bobSession.sessionId,
          payload: { upstreamClientThreadVisibility: "all_accessible" },
        });
        expect(updatedBob.upstreamClientThreadVisibility).toBe("all_accessible");

        const mobileSnapAll = yield* adaptShellSnapshotForUpstreamCompat(
          teamService,
          bobSession.sessionId,
          snapshot,
          true,
        );
        expect(mobileSnapAll.threads.map((t) => [t.id, t.title])).toEqual([
          [aliceDefaultThread, "alice: Deploy fix"],
          [aliceLockedThread, "alice: Release lock"],
          [bobThread, "bob: Bob task"],
        ]);

        // 4. Thread projection, stream events, searchThreads, getThreadTitles, getThreadLinkMetadata, and relay push titles all prefix!
        const adaptedProj = yield* adaptThreadProjectionForUpstreamCompat(
          teamService,
          makeThreadProjection(aliceDefaultThread, "Deploy fix"),
          true,
        );
        expect(adaptedProj.thread.title).toBe("alice: Deploy fix");

        const adaptedStreamEvent = yield* adaptThreadStreamItemForUpstreamCompat(
          teamService,
          {
            kind: "event",
            sequence: 3,
            event: {
              type: "thread.metadata-updated",
              payload: { id: aliceDefaultThread, title: "Deploy fix v2" },
            },
          } as unknown as OrchestrationV2ThreadStreamItem,
          true,
        );
        expect(
          adaptedStreamEvent.kind === "event"
            ? (adaptedStreamEvent.event.payload as { title: string }).title
            : null,
        ).toBe("alice: Deploy fix v2");

        const adaptedSearch = yield* adaptSearchThreadsResultForUpstreamCompat(
          teamService,
          {
            matches: [],
            threads: [makeThreadShell(aliceDefaultThread, "Deploy fix")],
          },
          true,
        );
        expect(adaptedSearch.threads?.[0]?.title).toBe("alice: Deploy fix");

        const adaptedTitles = yield* adaptThreadTitlesForUpstreamCompat(
          teamService,
          { [aliceDefaultThread]: "Deploy fix", [bobThread]: "Bob task" },
          true,
        );
        expect(adaptedTitles).toEqual({
          [aliceDefaultThread]: "alice: Deploy fix",
          [bobThread]: "bob: Bob task",
        });

        const adaptedLinkMeta = yield* adaptThreadLinkMetadataForUpstreamCompat(
          teamService,
          { [aliceDefaultThread]: { title: "Deploy fix", projectId: ProjectId.make("project-1") } },
          true,
        );
        expect(adaptedLinkMeta[aliceDefaultThread]?.title).toBe("alice: Deploy fix");

        expect(
          yield* teamService.formatUpstreamCompatThreadTitle(aliceDefaultThread, "Deploy fix"),
        ).toBe("alice: Deploy fix");

        // 5. Rename hygiene: mobile renaming Bob's thread with "bob: Bob renamed" strips prefix before persisting!
        const renameCmd: OrchestrationV2Command = {
          type: "thread.metadata.update",
          commandId: CommandId.make("cmd-rename-1"),
          threadId: bobThread,
          title: "bob: bob: Bob renamed",
        };
        const normalizedRename = yield* teamService.assertAndNormalizeDispatchCommand(
          bobSession.sessionId,
          renameCmd,
          { upstreamCompat: true },
        );
        expect(
          normalizedRename.type === "thread.metadata.update" ? normalizedRename.title : null,
        ).toBe("Bob renamed");

        // Forked client rename is NOT stripped.
        const forkedRename = yield* teamService.assertAndNormalizeDispatchCommand(
          bobSession.sessionId,
          {
            type: "thread.metadata.update",
            commandId: CommandId.make("cmd-rename-2"),
            threadId: bobThread,
            title: "bob: keep literal",
          },
          { upstreamCompat: false },
        );
        expect(forkedRename.type === "thread.metadata.update" ? forkedRename.title : null).toBe(
          "bob: keep literal",
        );

        // 6. Strict RBAC & clear upstream-compat errors on locked thread & local-synced thread!
        const lockedErr = yield* Effect.flip(
          teamService.assertAndNormalizeDispatchCommand(
            bobSession.sessionId,
            {
              type: "message.dispatch",
              commandId: CommandId.make("cmd-msg-locked"),
              threadId: aliceLockedThread,
              messageId: MessageId.make("msg-1"),
              text: "hello",
              dispatchMode: { type: "queue_after_active" },
            } as unknown as OrchestrationV2Command,
            { upstreamCompat: true },
          ),
        );
        expect(lockedErr.message).toContain("locked");

        const localErr = yield* Effect.flip(
          teamService.assertAndNormalizeDispatchCommand(
            bobSession.sessionId,
            {
              type: "message.dispatch",
              commandId: CommandId.make("cmd-msg-local"),
              threadId: aliceLocalThread,
              messageId: MessageId.make("msg-2"),
              text: "hello",
              dispatchMode: { type: "queue_after_active" },
            } as unknown as OrchestrationV2Command,
            { upstreamCompat: true },
          ),
        );
        expect(localErr.message).toContain("Desktop or Web");
        expect(localErr.message).toContain("Note");

        // 7. shouldRefreshShellForAccessChange scopes visibility/follow changes strictly to that member's upstreamCompat sessions.
        expect(
          yield* teamService.shouldRefreshShellForAccessChange(
            bobSession.sessionId,
            { type: "memberVisibility", memberId: bobRedeemed.member.id },
            { upstreamCompat: true },
          ),
        ).toBe(true);
        expect(
          yield* teamService.shouldRefreshShellForAccessChange(
            bobSession.sessionId,
            { type: "memberVisibility", memberId: bobRedeemed.member.id },
            { upstreamCompat: false },
          ),
        ).toBe(false);
        expect(
          yield* teamService.shouldRefreshShellForAccessChange(
            aliceSession.sessionId,
            { type: "memberVisibility", memberId: bobRedeemed.member.id },
            { upstreamCompat: true },
          ),
        ).toBe(false);
        expect(
          yield* teamService.shouldRefreshShellForAccessChange(
            bobSession.sessionId,
            { type: "memberPseudo", memberId: TeamMemberId.make(init.owner.id) },
            { upstreamCompat: true },
          ),
        ).toBe(true);
        expect(
          yield* teamService.shouldRefreshShellForAccessChange(
            bobSession.sessionId,
            { type: "memberPseudo", memberId: TeamMemberId.make(init.owner.id) },
            { upstreamCompat: false },
          ),
        ).toBe(false);
      }).pipe(Effect.provide(makeTestLayer())),
  );
});
