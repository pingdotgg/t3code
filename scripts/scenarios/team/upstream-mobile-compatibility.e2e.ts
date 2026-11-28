import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ShellSnapshot,
  ProjectId,
  ProviderInstanceId,
  TEAM_CLIENT_CAPABILITY_HEADER,
  TEAM_CLIENT_CAPABILITY_VALUE,
  ThreadId,
  WsRpcGroup,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { runPromise } from "../t3.ts";
import { startTeamTopology, type TeamMemberHandle } from "./topology.ts";
import { openTeamInviteForm, selectTeamSettingsTab } from "./ui-helpers.ts";

async function waitForAssistantTurnSettled(
  page: TeamMemberHandle["page"],
  minAssistantMessages: number,
) {
  await expect
    .poll(async () => await page.locator('[data-message-role="assistant"]').count(), {
      timeout: 25_000,
    })
    .toBeGreaterThanOrEqual(minAssistantMessages);
  await expect
    .poll(async () => await page.getByRole("button", { name: "Stop generation" }).count(), {
      timeout: 25_000,
    })
    .toBe(0);
}

/**
 * Connects an RPC WebSocket client WITHOUT `t3TeamsClient=1` or `X-T3-Teams-Client: 1`
 * to simulate the unmodified official upstream mobile app.
 */
const makeUpstreamMobileRpcClient = Effect.fn("scenario.m9a.makeUpstreamMobileRpcClient")(
  function* (origin: string, accessToken: string) {
    const { ticket } = yield* HttpClient.execute(
      HttpClientRequest.post(`${origin}/api/auth/websocket-ticket`).pipe(
        HttpClientRequest.bearerToken(accessToken),
      ),
    ).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Struct({ ticket: Schema.String }))),
      Effect.provide(FetchHttpClient.layer),
    );
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(
          Socket.layerWebSocket(
            `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`,
          ),
        ),
        Layer.provide(RpcSerialization.layerJson),
        Layer.provide(NodeWS.layerWebSocketConstructor),
      ),
    );
    return yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(protocol));
  },
);

async function redeemStandardPairingCodeAsUpstreamMobile(input: {
  readonly origin: string;
  readonly pairingCode: string;
}): Promise<{
  readonly status: number;
  readonly accessToken: string | null;
  readonly scope: string | null;
}> {
  return await runPromise(
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(
        HttpClientRequest.post(`${input.origin}/oauth/token`).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: AuthTokenExchangeGrantType,
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
            subject_token: input.pairingCode,
            client_label: "Upstream iPhone",
            client_device_type: "mobile",
            client_os: "iOS",
          }),
        ),
      );
      if (response.status !== 200) {
        return { status: response.status, accessToken: null, scope: null };
      }
      const body = yield* HttpClientResponse.schemaBodyJson(
        Schema.Struct({
          access_token: Schema.String,
          scope: Schema.String,
        }),
      )(response);
      return { status: 200, accessToken: body.access_token, scope: body.scope };
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
}

async function fetchShellSnapshotHttp(input: {
  readonly origin: string;
  readonly accessToken: string;
  readonly teamAware: boolean;
}): Promise<OrchestrationV2ShellSnapshot> {
  return await runPromise(
    Effect.gen(function* () {
      let req = HttpClientRequest.get(`${input.origin}/api/orchestration/shell`).pipe(
        HttpClientRequest.bearerToken(input.accessToken),
        HttpClientRequest.setHeader(
          ORCHESTRATION_PROTOCOL_HEADER,
          ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        ),
      );
      if (input.teamAware) {
        req = HttpClientRequest.setHeader(
          req,
          TEAM_CLIENT_CAPABILITY_HEADER,
          TEAM_CLIENT_CAPABILITY_VALUE,
        );
      }
      const response = yield* HttpClient.execute(req);
      expect(response.status).toBe(200);
      return yield* HttpClientResponse.schemaBodyJson(OrchestrationV2ShellSnapshot)(response);
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
}

test("unmodified upstream mobile client inherits member identity via standard pairing, gets dynamic title prefixes, strips prefixes on rename, respects live mobile visibility preference, and enforces RBAC", async ({
  app,
}) => {
  await using topology = await startTeamTopology({
    viteUrl: app.baseUrl ?? "",
    members: [
      { pseudo: "alice", role: "owner" },
      { pseudo: "bob", role: "regular" },
    ],
  });

  const alice = topology.member("alice");
  const bob = topology.member("bob");

  await topology.teamServer.project("team-app");

  // 1. Alice pairs with the Team Server, initializes the team, creates an Admin Only View, and invites Bob.
  await alice.pairWithRemoteServer({
    host: topology.teamServer.origin,
    pairingToken: topology.teamServer.pairingToken,
  });

  await alice.open("/settings/teams");
  await alice.page.getByTestId("team-server-select").click();
  await alice.page.getByRole("option", { name: /Team Server/ }).click();

  await alice.page.getByTestId("team-init-name").fill("Acme Engineering");
  await alice.page.getByTestId("team-init-pseudo").fill("alice");
  await alice.page.getByTestId("team-init-submit").click();
  await alice.page.getByTestId("team-member-alice").waitFor({ state: "visible", timeout: 15_000 });

  // Create Admin Only View (regular members cannot read or post).
  await selectTeamSettingsTab(alice.page, "access");
  await alice.page.getByTestId("team-view-create-open").click();
  await alice.page.getByTestId("team-view-name-input").fill("Exec Only");
  await alice.page.getByTestId("team-view-read-role-regular").click();
  await alice.page.getByTestId("team-view-read-role-modo").click();
  await alice.page.getByTestId("team-view-post-role-regular").click();
  await alice.page.getByTestId("team-view-post-role-modo").click();
  await alice.page.getByTestId("team-view-save").click();
  await alice.page
    .getByTestId("team-view-row-Exec Only")
    .waitFor({ state: "visible", timeout: 15_000 });

  // Invite Bob as regular.
  await openTeamInviteForm(alice.page);
  await alice.page.getByTestId("team-invite-role-select").click();
  await alice.page.getByRole("option", { name: "Regular" }).click();
  await alice.page.getByTestId("team-invite-pseudo-input").fill("bob");
  await alice.page.getByTestId("team-invite-create").click();
  await alice.page
    .getByTestId("team-invite-generated")
    .waitFor({ state: "visible", timeout: 15_000 });

  const aliceWebJoinLink = await alice.page.getByTestId("team-invite-weblink").inputValue();
  const parsedWebJoinUrl = new URL(aliceWebJoinLink);
  const bobJoinUrl = `${bob.origin}${parsedWebJoinUrl.pathname}${parsedWebJoinUrl.search}${parsedWebJoinUrl.hash}`;

  await bob.page.goto(bobJoinUrl, { waitUntil: "domcontentloaded" });
  await bob.page.getByTestId("team-join-preview").waitFor({ state: "visible", timeout: 15_000 });
  await bob.page.getByTestId("team-join-submit").click();
  await bob.page
    .getByTestId("team-colleagues-toggle")
    .waitFor({ state: "visible", timeout: 20_000 });

  // 2. Alice creates three threads on the Team Server:
  //    (a) Default View unlocked: "Deploy pipeline fix"
  //    (b) Default View locked:   "Release lock"
  //    (c) Exec Only View:        "Secret roadmap"
  await alice.open("/");
  await alice.page
    .getByTestId("team-colleagues-toggle")
    .waitFor({ state: "visible", timeout: 15_000 });

  const createAliceThread = async (
    promptText: string,
    options?: { readonly lock?: boolean; readonly viewName?: string },
  ) => {
    await alice.page.getByRole("button", { name: "New thread" }).first().click();
    const composer = alice.page.locator('[contenteditable="true"]').first();
    await composer.waitFor({ state: "visible", timeout: 15_000 });

    if (options?.viewName) {
      await alice.page
        .getByTestId("team-draft-view-select")
        .waitFor({ state: "visible", timeout: 15_000 });
      await alice.page.getByTestId("team-draft-view-select").click();
      await alice.page.getByTestId(`team-draft-view-option-${options.viewName}`).click();
    }
    if (options?.lock) {
      const lockToggle = alice.page.getByTestId("team-draft-lock-toggle");
      await lockToggle.waitFor({ state: "visible", timeout: 15_000 });
      await lockToggle.click();
      await expect
        .poll(async () => await lockToggle.getAttribute("aria-pressed"), { timeout: 10_000 })
        .toBe("true");
    }

    await composer.click();
    await composer.fill(promptText);
    await composer.press("Enter");
    await expect
      .poll(
        async () =>
          (await alice.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "",
        { timeout: 20_000 },
      )
      .toContain(`alice: ${promptText}`);
    await waitForAssistantTurnSettled(alice.page, 1);
  };

  await createAliceThread("Deploy pipeline fix");
  await createAliceThread("Release lock", { lock: true });
  await createAliceThread("Secret roadmap", { viewName: "Exec Only" });

  // 3. Bob opens Settings -> Teams -> Upstream mobile app and creates a member-bound mobile pairing code.
  await bob.open("/settings/teams");
  await bob.page
    .getByTestId("team-mobile-compat-section")
    .waitFor({ state: "visible", timeout: 15_000 });
  await bob.page.getByTestId("team-mobile-pairing-label-input").fill("Bob iPhone");
  await bob.page.getByTestId("team-mobile-pairing-create").click();
  await bob.page
    .getByTestId("team-mobile-pairing-generated")
    .waitFor({ state: "visible", timeout: 15_000 });
  await bob.page.getByTestId("team-mobile-pairing-qr").waitFor({ state: "visible" });
  const bobPairingCode = await bob.page.getByTestId("team-mobile-pairing-code").inputValue();
  expect(bobPairingCode.length).toBeGreaterThan(6);

  // Also grab Alice's admin/owner token via a member-bound pairing code from Alice's Settings -> Teams
  // so we can inspect raw SQLite/forked state and sync a local thread cleanly.
  await alice.open("/settings/teams");
  await alice.page
    .getByTestId("team-mobile-compat-section")
    .waitFor({ state: "visible", timeout: 15_000 });
  await alice.page.getByTestId("team-mobile-pairing-create").click();
  await alice.page
    .getByTestId("team-mobile-pairing-generated")
    .waitFor({ state: "visible", timeout: 15_000 });
  const alicePairingCode = await alice.page.getByTestId("team-mobile-pairing-code").inputValue();
  const aliceRedeemed = await redeemStandardPairingCodeAsUpstreamMobile({
    origin: topology.teamServer.origin,
    pairingCode: alicePairingCode,
  });
  expect(aliceRedeemed.status).toBe(200);
  const aliceToken = aliceRedeemed.accessToken!;

  // 4. Unmodified upstream mobile client redeems Bob's standard pairing code (NO fork header).
  const bobMobileRedeemed = await redeemStandardPairingCodeAsUpstreamMobile({
    origin: topology.teamServer.origin,
    pairingCode: bobPairingCode,
  });
  expect(bobMobileRedeemed.status).toBe(200);
  const bobMobileToken = bobMobileRedeemed.accessToken!;
  // Regular member cannot receive admin access-write scope.
  expect(bobMobileRedeemed.scope ?? "").not.toContain("auth:access:write");

  // Discover project & Alice thread IDs via Alice's forked (team-aware) HTTP snapshot.
  const aliceForkedSnapshot = await fetchShellSnapshotHttp({
    origin: topology.teamServer.origin,
    accessToken: aliceToken,
    teamAware: true,
  });
  const teamProjectId = aliceForkedSnapshot.projects[0]!.id;
  const aliceDeployThread = aliceForkedSnapshot.threads.find(
    (t) => t.title === "Deploy pipeline fix",
  );
  const aliceLockedThread = aliceForkedSnapshot.threads.find((t) => t.title === "Release lock");
  const aliceSecretThread = aliceForkedSnapshot.threads.find((t) => t.title === "Secret roadmap");
  expect(aliceDeployThread).toBeDefined();
  expect(aliceLockedThread).toBeDefined();
  expect(aliceSecretThread).toBeDefined();

  // 5. Verify default mobile visibility (owned_and_followed): Bob's mobile HTTP shell snapshot hides Alice's unfollowed threads!
  const bobMobileHttpInitial = await fetchShellSnapshotHttp({
    origin: topology.teamServer.origin,
    accessToken: bobMobileToken,
    teamAware: false,
  });
  expect(bobMobileHttpInitial.threads).toEqual([]);

  // 6. Open a LIVE unmodified upstream mobile WS session (no t3TeamsClient=1) and run all live checks!
  await runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const mobileClient = yield* makeUpstreamMobileRpcClient(
          topology.teamServer.origin,
          bobMobileToken,
        );

        // Keep a live subscribeShell stream open throughout so we prove live push on follow & visibility toggle!
        const liveShellThreads = new Map<string, string>();
        const liveSnoozes = new Map<string, string>();
        const shellFiber = yield* mobileClient[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
          Stream.runForEach((item: OrchestrationV2ShellStreamItem) =>
            Effect.sync(() => {
              if (item.kind === "snapshot") {
                liveShellThreads.clear();
                liveSnoozes.clear();
                for (const t of item.snapshot.threads) {
                  liveShellThreads.set(t.id, t.title);
                  if (t.snoozedUntil != null)
                    liveSnoozes.set(t.id, DateTime.formatIso(t.snoozedUntil));
                }
              } else if (item.kind === "thread.updated") {
                liveShellThreads.set(item.thread.id, item.thread.title);
                if (item.thread.snoozedUntil == null) liveSnoozes.delete(item.thread.id);
                else liveSnoozes.set(item.thread.id, DateTime.formatIso(item.thread.snoozedUntil));
              } else if (item.kind === "thread.removed") {
                liveShellThreads.delete(item.threadId);
              }
            }),
          ),
          Effect.forkScoped,
        );

        // Create Bob's own thread from the upstream mobile client.
        const bobMobileThreadId = ThreadId.make("thread-bob-mobile-e2e");
        yield* mobileClient[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.create",
          createdBy: "user",
          creationSource: "mobile",
          commandId: CommandId.make("cmd-bob-mobile-create"),
          threadId: bobMobileThreadId,
          projectId: ProjectId.make(teamProjectId),
          title: "Bob mobile task",
          modelSelection: {
            instanceId: ProviderInstanceId.make("devReplay"),
            model: "dev-replay-multi-turn",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });

        // Live mobile subscribeShell receives dynamically prefixed title "bob: Bob mobile task"!
        yield* Effect.promise(() =>
          expect
            .poll(() => liveShellThreads.get(bobMobileThreadId), { timeout: 15_000 })
            .toBe("bob: Bob mobile task"),
        );

        // Alice's unfollowed threads are NOT in Bob's mobile shell yet.
        expect(liveShellThreads.has(aliceDeployThread!.id)).toBe(false);
        expect(liveShellThreads.has(aliceLockedThread!.id)).toBe(false);
        expect(liveShellThreads.has(aliceSecretThread!.id)).toBe(false);

        // getThreadProjection, subscribeThread, getThreadTitles, and searchThreads all return prefixed title!
        const mobileProjection = yield* mobileClient[
          ORCHESTRATION_V2_WS_METHODS.getThreadProjection
        ]({ threadId: bobMobileThreadId });
        expect(mobileProjection.thread.title).toBe("bob: Bob mobile task");

        const mobileTitles = yield* mobileClient[ORCHESTRATION_V2_WS_METHODS.getThreadTitles]({
          threadIds: [bobMobileThreadId, aliceDeployThread!.id, aliceSecretThread!.id],
        });
        expect(mobileTitles[bobMobileThreadId]).toBe("bob: Bob mobile task");
        expect(mobileTitles[aliceDeployThread!.id]).toBe("alice: Deploy pipeline fix");
        expect(mobileTitles[aliceSecretThread!.id]).toBeUndefined();

        const firstThreadStreamItem = yield* mobileClient[
          ORCHESTRATION_V2_WS_METHODS.subscribeThread
        ]({ threadId: bobMobileThreadId }).pipe(
          Stream.filter((item: OrchestrationV2ThreadStreamItem) => item.kind === "snapshot"),
          Stream.runHead,
        );
        expect(
          firstThreadStreamItem._tag === "Some" && firstThreadStreamItem.value.kind === "snapshot"
            ? firstThreadStreamItem.value.projection.thread.title
            : null,
        ).toBe("bob: Bob mobile task");

        // Verify SQLite holds the RAW unprefixed title (forked team-aware HTTP client sees raw title).
        const forkedCheckBeforeRename = yield* Effect.promise(() =>
          fetchShellSnapshotHttp({
            origin: topology.teamServer.origin,
            accessToken: aliceToken,
            teamAware: true,
          }),
        );
        expect(forkedCheckBeforeRename.threads.find((t) => t.id === bobMobileThreadId)?.title).toBe(
          "Bob mobile task",
        );

        // 7. Rename hygiene: upstream mobile renames sending "bob: Bob renamed task" -> server strips prefix!
        yield* mobileClient[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.metadata.update",
          commandId: CommandId.make("cmd-bob-mobile-rename"),
          threadId: bobMobileThreadId,
          title: "bob: Bob renamed task",
        });

        yield* Effect.promise(() =>
          expect
            .poll(() => liveShellThreads.get(bobMobileThreadId), { timeout: 15_000 })
            .toBe("bob: Bob renamed task"),
        );
        const forkedCheckAfterRename = yield* Effect.promise(() =>
          fetchShellSnapshotHttp({
            origin: topology.teamServer.origin,
            accessToken: aliceToken,
            teamAware: true,
          }),
        );
        expect(forkedCheckAfterRename.threads.find((t) => t.id === bobMobileThreadId)?.title).toBe(
          "Bob renamed task",
        );

        // 8. Bob follows Alice's "Deploy pipeline fix" in his browser -> mobile live shell immediately receives "alice: Deploy pipeline fix"!
        yield* Effect.promise(async () => {
          await bob.open("/");
          await bob.page
            .getByTestId("team-colleagues-toggle")
            .waitFor({ state: "visible", timeout: 15_000 });
          await bob.page.getByTestId("team-colleagues-toggle").click();
          const deployRow = bob.page
            .locator("aside, [data-sidebar='sidebar']")
            .first()
            .locator("[data-sidebar-row]", { hasText: "Deploy pipeline fix" })
            .first();
          await deployRow.waitFor({ state: "visible", timeout: 15_000 });
          await deployRow.focus();
          await deployRow.press("Enter");
          const followBtn = bob.page.getByTestId("team-thread-follow-button");
          await followBtn.waitFor({ state: "visible", timeout: 15_000 });
          await followBtn.click();
          await expect
            .poll(async () => await followBtn.getAttribute("aria-pressed"), { timeout: 10_000 })
            .toBe("true");
        });

        yield* Effect.promise(() =>
          expect
            .poll(() => liveShellThreads.get(aliceDeployThread!.id), { timeout: 15_000 })
            .toBe("alice: Deploy pipeline fix"),
        );
        // Unfollowed locked thread is STILL hidden while in owned_and_followed mode.
        expect(liveShellThreads.has(aliceLockedThread!.id)).toBe(false);

        const snoozedUntil = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 }));
        const followedThreadId = aliceDeployThread!.id;
        yield* mobileClient[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.snooze",
          commandId: CommandId.make("cmd-bob-mobile-snooze"),
          threadId: followedThreadId,
          snoozedUntil,
        });
        yield* Effect.promise(() =>
          expect.poll(() => liveSnoozes.get(followedThreadId)).toBe(snoozedUntil),
        );
        const bobProjection = yield* mobileClient[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: followedThreadId,
        });
        expect(DateTime.formatIso(bobProjection.thread.snoozedUntil!)).toBe(snoozedUntil);
        const aliceMobileShell = yield* Effect.promise(() =>
          fetchShellSnapshotHttp({
            origin: topology.teamServer.origin,
            accessToken: aliceToken,
            teamAware: false,
          }),
        );
        expect(
          aliceMobileShell.threads.find((t) => t.id === followedThreadId)?.snoozedUntil,
        ).toBeNull();
        yield* mobileClient[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.unsnooze",
          commandId: CommandId.make("cmd-bob-mobile-unsnooze"),
          threadId: followedThreadId,
          reason: "user",
        });
        yield* Effect.promise(() =>
          expect.poll(() => liveSnoozes.has(followedThreadId)).toBe(false),
        );

        // 9. Bob flips Settings -> Teams -> Visible threads on upstream mobile to "All accessible team threads"!
        yield* Effect.promise(async () => {
          await bob.open("/settings/teams");
          await bob.page
            .getByTestId("team-mobile-visibility-select")
            .waitFor({ state: "visible", timeout: 15_000 });
          await bob.page.getByTestId("team-mobile-visibility-select").click();
          await bob.page.getByRole("option", { name: "All accessible team threads" }).click();
        });

        // Mobile live shell updates automatically to include "alice: Release lock", while Exec Only stays hidden!
        yield* Effect.promise(() =>
          expect
            .poll(() => liveShellThreads.get(aliceLockedThread!.id), { timeout: 15_000 })
            .toBe("alice: Release lock"),
        );
        expect(liveShellThreads.has(aliceSecretThread!.id)).toBe(false);

        // 10. RBAC & clear server-side errors enforced for unmodified mobile client:
        // (a) Admin-only View direct read fails!
        const secretReadExit = yield* Effect.exit(
          mobileClient[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: aliceSecretThread!.id,
          }),
        );
        expect(secretReadExit._tag).toBe("Failure");

        // (b) Posting to locked thread fails with clear locked error!
        const lockedPostError = yield* Effect.flip(
          mobileClient[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "mobile",
            commandId: CommandId.make("cmd-bob-mobile-locked-post"),
            threadId: aliceLockedThread!.id,
            messageId: MessageId.make("msg-bob-locked"),
            text: "Can I post here?",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          }),
        );
        expect(String(lockedPostError.message)).toContain("locked");

        // (c) Posting to a colleague's local-synced thread fails with clear Desktop/Web Note/Fork guidance!
        const aliceLocalThreadId = ThreadId.make("thread-alice-local-synced-e2e");
        const aliceWsClient = yield* makeUpstreamMobileRpcClient(
          topology.teamServer.origin,
          aliceToken,
        );
        yield* aliceWsClient["team.assignProject"]({
          projectId: ProjectId.make(teamProjectId),
        });
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        yield* aliceWsClient["team.syncLocalThread"]({
          threadId: aliceLocalThreadId,
          projectId: ProjectId.make(teamProjectId),
          title: "Alice local work",
          branch: null,
          executionEnvironmentId: EnvironmentId.make("env-alice-laptop-e2e"),
          executionEnvironmentLabel: "alice's laptop",
          modelSelection: {
            instanceId: ProviderInstanceId.make("devReplay"),
            model: "dev-replay-multi-turn",
          },
          runs: [],
          messages: [],
          createdAt: nowIso,
          updatedAt: nowIso,
        });

        const localPostError = yield* Effect.flip(
          mobileClient[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "mobile",
            commandId: CommandId.make("cmd-bob-mobile-local-post"),
            threadId: aliceLocalThreadId,
            messageId: MessageId.make("msg-bob-local"),
            text: "Run on Alice laptop",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          }),
        );
        expect(String(localPostError.message)).toContain("Desktop or Web");
        expect(String(localPostError.message)).toContain("Note");

        yield* Fiber.interrupt(shellFiber);
      }),
    ),
  );

  // 11. Suspension fail-closed: Bob mints a second pairing code, Alice suspends Bob -> redeeming fails with 401!
  await bob.page.getByTestId("team-mobile-pairing-label-input").fill("Bob Tablet");
  await bob.page.getByTestId("team-mobile-pairing-create").click();
  await expect
    .poll(async () => await bob.page.getByTestId("team-mobile-pairing-code").inputValue(), {
      timeout: 15_000,
    })
    .not.toBe(bobPairingCode);
  const bobSecondPairingCode = await bob.page.getByTestId("team-mobile-pairing-code").inputValue();

  await alice.open("/settings/teams");
  await alice.page
    .getByTestId("team-member-suspend-bob")
    .waitFor({ state: "visible", timeout: 15_000 });
  await alice.page.getByTestId("team-member-suspend-bob").click();
  await expect
    .poll(async () => (await alice.page.getByTestId("team-member-bob").textContent()) ?? "", {
      timeout: 15_000,
    })
    .toContain("Suspended");

  const suspendedRedeem = await redeemStandardPairingCodeAsUpstreamMobile({
    origin: topology.teamServer.origin,
    pairingCode: bobSecondPairingCode,
  });
  expect(suspendedRedeem.status).toBe(401);
});
