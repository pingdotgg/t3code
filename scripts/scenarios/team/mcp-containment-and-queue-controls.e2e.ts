// @effect-diagnostics nodeBuiltinImport:off -- The scenario registers a local ACP probe script and reads its JSONL log.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ProviderDriverKind,
  ProviderInstanceId,
  WsRpcGroup,
  parseTeamJoinLink,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { TEAM_SCENARIOS_HOME } from "../../e2e.team.config.ts";
import { rpcClient, runPromise } from "../t3.ts";
import { startT3ServerProcess, startTeamTopology, type TeamMemberHandle } from "./topology.ts";
import { openTeamInviteForm, selectTeamSettingsTab } from "./ui-helpers.ts";

// Minimal ACP agent that logs its PID and injected T3 MCP endpoint/token on every prompt so the
// E2E test can verify real actingMemberId-bound /mcp calls, warm session recycling on author
// switches, and revocation of the previous author's MCP token.
const MCP_PROBE_ACP = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const logPath = join(process.cwd(), "mcp-probe-turns.jsonl");
let sessionId = "mcp-probe-session-" + process.pid;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");

const waitForRelease = (turnNum) =>
  new Promise((resolve) => {
    const signalPath = join(process.cwd(), "mcp-probe-release-" + turnNum);
    const check = () => {
      if (existsSync(signalPath)) resolve();
      else setTimeout(check, 25);
    };
    check();
  });

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined || method === undefined) continue;
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: {} },
        authMethods: [],
        agentInfo: { name: "MCP Probe", version: "1.0.0" },
      },
    });
  } else if (method === "session/new") {
    send({ id, result: { sessionId } });
  } else if (method === "session/load") {
    if (params && typeof params.sessionId === "string") sessionId = params.sessionId;
    send({ id, result: {} });
  } else if (method === "session/prompt") {
    const prevLines = existsSync(logPath)
      ? readFileSync(logPath, "utf8").split("\\n").filter((l) => l.trim().length > 0).length
      : 0;
    const turnNum = prevLines + 1;
    appendFileSync(
      logPath,
      JSON.stringify({
        turnNum,
        pid: process.pid,
        endpoint: process.env.T3_ACP_MCP_ENDPOINT ?? null,
        authorization: process.env.T3_ACP_MCP_AUTHORIZATION ?? null,
      }) + "\\n",
      "utf8",
    );
    await waitForRelease(turnNum);
    send({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "MCP_PROBE_OK pid=" + process.pid },
        },
      },
    });
    send({ id, result: { stopReason: "end_turn" } });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

interface ProbeTurnRecord {
  readonly pid: number;
  readonly endpoint: string | null;
  readonly authorization: string | null;
}

function readProbeRecords(logPath: string): ReadonlyArray<ProbeTurnRecord> {
  if (!NodeFS.existsSync(logPath)) return [];
  return NodeFS.readFileSync(logPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ProbeTurnRecord);
}

async function createInviteLink(input: {
  readonly inviter: TeamMemberHandle;
  readonly roleLabel: string;
  readonly pseudo: string;
}): Promise<string> {
  const { inviter, roleLabel, pseudo } = input;
  await openTeamInviteForm(inviter.page);
  await inviter.page.getByTestId("team-invite-role-select").click();
  await inviter.page.getByRole("option", { name: roleLabel }).click();
  await inviter.page.getByTestId("team-invite-pseudo-input").fill(pseudo);
  await inviter.page.getByTestId("team-invite-create").click();
  await inviter.page
    .getByTestId("team-invite-generated")
    .waitFor({ state: "visible", timeout: 15_000 });
  await expect
    .poll(async () => await inviter.page.getByTestId("team-invite-weblink").inputValue(), {
      timeout: 15_000,
    })
    .toContain(`pseudo=${encodeURIComponent(pseudo)}`);
  return await inviter.page.getByTestId("team-invite-weblink").inputValue();
}

async function createInviteAndJoin(input: {
  readonly inviter: TeamMemberHandle;
  readonly invitee: TeamMemberHandle;
  readonly roleLabel: string;
  readonly pseudo: string;
}) {
  const { invitee } = input;
  const webJoinLink = await createInviteLink(input);
  const parsedUrl = new URL(webJoinLink);
  const joinUrl = `${invitee.origin}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;

  await invitee.page.goto(joinUrl, { waitUntil: "domcontentloaded" });
  await invitee.page
    .getByTestId("team-join-preview")
    .waitFor({ state: "visible", timeout: 15_000 });
  await invitee.page.getByTestId("team-join-submit").click();
  await invitee.page
    .getByTestId("team-colleagues-toggle")
    .waitFor({ state: "visible", timeout: 20_000 });
}

const rpcClientForBearer = Effect.fn("scenario.rpcClientForBearer")(function* (
  origin: string,
  bearerToken: string,
) {
  const { ticket } = yield* HttpClient.execute(
    HttpClientRequest.post(`${origin}/api/auth/websocket-ticket`).pipe(
      HttpClientRequest.bearerToken(bearerToken),
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
});

interface McpCallResponse {
  readonly status: number;
  readonly isError: boolean;
  readonly text: string;
}

async function callMcpTool(input: {
  readonly request: TeamMemberHandle["page"]["request"];
  readonly endpoint: string;
  readonly authorization: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}): Promise<McpCallResponse> {
  const headers = {
    authorization: input.authorization,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const initRes = await input.request.post(input.endpoint, {
    headers,
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "team-m4-e2e", version: "1.0.0" },
      },
    },
  });
  if (initRes.status() !== 200) {
    return {
      status: initRes.status(),
      isError: true,
      text: await initRes.text(),
    };
  }
  const sessionIdHeader = initRes.headers()["mcp-session-id"];
  const callRes = await input.request.post(input.endpoint, {
    headers: {
      ...headers,
      "mcp-protocol-version": "2025-06-18",
      ...(sessionIdHeader ? { "mcp-session-id": sessionIdHeader } : {}),
    },
    data: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: input.toolName,
        arguments: input.args,
      },
    },
  });
  const rawBody = await callRes.text();
  const jsonLine = rawBody
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data:") || line.startsWith("{"));
  const jsonPayload = jsonLine?.startsWith("data:") ? jsonLine.slice(5).trim() : (jsonLine ?? "{}");
  const parsed = JSON.parse(jsonPayload) as {
    readonly result?: {
      readonly isError?: boolean;
      readonly content?: ReadonlyArray<{ readonly text?: string }>;
    };
    readonly error?: { readonly message?: string };
  };
  const contentText = (parsed.result?.content ?? []).map((item) => item.text ?? "").join("\n");
  return {
    status: callRes.status(),
    isError: parsed.result?.isError === true || parsed.error !== undefined,
    text: contentText || parsed.error?.message || rawBody,
  };
}

async function selectSupervisedMode(page: TeamMemberHandle["page"]) {
  const permsTrigger = page.getByRole("button", { name: /^Permissions:/ }).first();
  await permsTrigger.waitFor({ state: "visible", timeout: 15_000 });
  const label = (await permsTrigger.getAttribute("aria-label")) ?? "";
  if (label.includes("Supervised")) return;
  await permsTrigger.click();
  await page.getByRole("menuitemradio", { name: "Supervised" }).click();
}

test("enforces Milestone 4 mid-turn queueing, creator-only Send now, explicit owner/admin Interrupt, MCP member containment, warm session recycling, and --team-hub-only mode", async ({
  app,
}) => {
  // Use devReplay `approval` with `approval-required` so turns deterministically stay active
  // (waiting on tool approval) with canPromoteToSteer=true and zero timing races.
  await using topology = await startTeamTopology({
    viteUrl: app.baseUrl ?? "",
    members: [
      { pseudo: "alice", role: "owner" },
      { pseudo: "charlie", role: "modo" },
      { pseudo: "bob", role: "regular" },
    ],
    teamServerSettingsPatch: {
      defaultModelSelection: { instanceId: "devReplay", model: "approval" },
      defaultRuntimeMode: "approval-required",
    },
  });

  const alice = topology.member("alice");
  const charlie = topology.member("charlie");
  const bob = topology.member("bob");

  const projectDir = await topology.teamServer.project("team-app", {
    "mcp-probe-agent.mjs": MCP_PROBE_ACP,
  });
  const probeLogPath = NodePath.join(projectDir, "mcp-probe-turns.jsonl");
  const probeInstanceId = ProviderInstanceId.make("mcp-probe");

  // Register the local ACP probe provider on the Team Server so we can test real
  // actingMemberId-bound MCP tokens and warm-session recycling when authors switch.
  await runPromise(
    Effect.gen(function* () {
      const client = yield* rpcClient(topology.teamServer.home, topology.teamServer.origin);
      yield* client["server.updateSettings"]({
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: probeInstanceId,
          instance: {
            driver: ProviderDriverKind.make("acpRegistry"),
            displayName: "MCP Probe",
            enabled: true,
            config: {
              source: "local",
              commandPath: process.execPath,
              commandArgs: [NodePath.join(projectDir, "mcp-probe-agent.mjs")],
            },
          },
        },
      });
    }).pipe(Effect.scoped),
  );

  // 1. Alice pairs with the Team Server, initializes the team, and invites Charlie (modo) & Bob (regular).
  await alice.pairWithRemoteServer({
    host: topology.teamServer.origin,
    pairingToken: topology.teamServer.pairingToken,
  });
  await alice.open("/settings/teams");
  await alice.page.getByTestId("team-server-select").click();
  await alice.page.getByRole("option", { name: /Team Server/ }).click();
  await alice.page.getByTestId("team-init-name").fill("Containment Corp");
  await alice.page.getByTestId("team-init-pseudo").fill("alice");
  await alice.page.getByTestId("team-init-submit").click();
  await alice.page.getByTestId("team-member-alice").waitFor({ state: "visible", timeout: 15_000 });

  await createInviteAndJoin({
    inviter: alice,
    invitee: charlie,
    roleLabel: "Modo",
    pseudo: "charlie",
  });
  await createInviteAndJoin({
    inviter: alice,
    invitee: bob,
    roleLabel: "Regular",
    pseudo: "bob",
  });

  // Mint an authenticated Admin bearer token so server.updateSettings runs as a Team Admin.
  const adminJoinLink = await createInviteLink({
    inviter: alice,
    roleLabel: "Admin",
    pseudo: "admin-ops",
  });
  const adminParsed = parseTeamJoinLink(adminJoinLink);
  expect(adminParsed).not.toBeNull();
  const adminRedeemRes = await alice.page.request.post(
    `${topology.teamServer.origin}/api/team/invites/redeem`,
    {
      headers: { "content-type": "application/json" },
      data: { token: adminParsed!.token, pseudo: "admin-ops" },
    },
  );
  expect(adminRedeemRes.status()).toBe(200);
  const { accessToken: adminBearerToken } = (await adminRedeemRes.json()) as {
    readonly accessToken: string;
  };

  // Create "Staff Only" View (owner/admin/modo only) for MCP read-containment checks.
  await selectTeamSettingsTab(alice.page, "access");
  await alice.page.getByTestId("team-view-create-open").click();
  await alice.page.getByTestId("team-view-name-input").fill("Staff Only");
  await alice.page.getByTestId("team-view-read-role-regular").click();
  await alice.page.getByTestId("team-view-post-role-regular").click();
  await alice.page.getByTestId("team-view-save").click();
  await alice.page
    .getByTestId("team-view-row-Staff Only")
    .waitFor({ state: "visible", timeout: 15_000 });

  // Enable desktop notifications and colleagues toggle for all three browsers so we can verify
  // mid-turn queued-message notifications fire strictly for the creator / active turn author.
  for (const member of [alice, charlie, bob]) {
    await member.open("/settings/general");
    const notificationSelect = member.page.getByLabel("Thread notifications");
    await notificationSelect.waitFor({ state: "visible", timeout: 15_000 });
    await notificationSelect.click();
    await member.page.getByRole("option", { name: "Notifications only" }).click();

    await member.open("/");
    await member.page
      .getByTestId("team-colleagues-toggle")
      .waitFor({ state: "visible", timeout: 15_000 });
    await member.page.getByTestId("team-colleagues-toggle").click();
  }

  // 2. Alice creates a "Staff Only" thread so we can prove regular MCP callers cannot read/list it.
  await alice.page.getByRole("button", { name: "New thread" }).first().click();
  await alice.page
    .getByTestId("team-draft-view-select")
    .waitFor({ state: "visible", timeout: 15_000 });
  await alice.page.getByTestId("team-draft-view-select").click();
  await alice.page.getByTestId("team-draft-view-option-Staff Only").click();
  const aliceComposer = alice.page.locator('[contenteditable="true"]').first();
  await aliceComposer.click();
  await aliceComposer.fill("Secret M4 plan");
  await aliceComposer.press("Enter");
  await expect
    .poll(
      async () =>
        (await alice.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "",
      { timeout: 20_000 },
    )
    .toContain("alice: Secret M4 plan");
  const staffThreadId = new URL(alice.page.url()).pathname.split("/").filter(Boolean).at(-1) ?? "";
  expect(staffThreadId.length).toBeGreaterThan(0);

  // 3. Alice starts an active Supervised Default-View thread ("Alice running turn").
  //    Supervised mode holds the devReplay `approval` turn open waiting on tool approval
  //    so mid-turn queueing, creator-only Send now, and Interrupt controls are 100% deterministic.
  await alice.page.getByRole("button", { name: "New thread" }).first().click();
  await aliceComposer.waitFor({ state: "visible", timeout: 15_000 });
  await selectSupervisedMode(alice.page);
  await aliceComposer.click();
  await aliceComposer.fill("Alice running turn");
  await aliceComposer.press("Enter");

  await expect
    .poll(
      async () =>
        (await alice.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "",
      { timeout: 20_000 },
    )
    .toContain("alice: Alice running turn");
  await alice.page
    .getByRole("button", { name: "Stop generation" })
    .waitFor({ state: "visible", timeout: 25_000 });
  await alice.page
    .getByRole("button", { name: /^Approve/ })
    .first()
    .waitFor({ state: "visible", timeout: 25_000 });
  const aliceThreadId = new URL(alice.page.url()).pathname.split("/").filter(Boolean).at(-1) ?? "";
  expect(aliceThreadId.length).toBeGreaterThan(0);

  // Bob opens Alice's running thread:
  // - Sees NO Stop/Interrupt button (regular non-creator cannot interrupt!).
  // - Posts a message mid-turn -> NEVER auto-steers and NEVER declines Alice's pending approval!
  //   Enters native dashed queue with "bob" author pseudo, NO "Send now", NO Stop/Interrupt!
  const bobAliceRow = bob.page
    .locator("aside, [data-sidebar='sidebar']")
    .first()
    .locator("[data-sidebar-row]", { hasText: "Alice running turn" })
    .first();
  await expect
    .poll(async () => (await bobAliceRow.textContent().catch(() => "")) ?? "", { timeout: 20_000 })
    .toContain("alice: Alice running turn");
  await bobAliceRow.focus();
  await bobAliceRow.press("Enter");

  const bobComposer = bob.page.locator('[contenteditable="true"]').first();
  await bobComposer.waitFor({ state: "visible", timeout: 15_000 });
  await expect
    .poll(async () => await bob.page.locator('[data-message-role="user"]').count(), {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(1);
  expect(await bob.page.getByRole("button", { name: "Stop generation" }).count()).toBe(0);
  expect(await bob.page.getByTestId("team-admin-interrupt-button").count()).toBe(0);

  // Prepare browser Notification recorders before Bob queues a mid-turn message on Alice's thread:
  // Alice (thread creator & active turn author) MUST be notified; Bob (sender) and Charlie (unrelated) MUST NOT!
  await alice.clearNotifications();
  await charlie.clearNotifications();
  await bob.clearNotifications();
  await alice.setWindowFocused(false);
  await charlie.setWindowFocused(false);
  await bob.setWindowFocused(false);

  await bobComposer.click();
  await bobComposer.fill("Bob queued follow-up");
  await bobComposer.press("Enter");

  await expect
    .poll(
      async () =>
        (await bob.page
          .getByTestId("team-queued-author")
          .textContent()
          .catch(() => "")) ?? "",
      { timeout: 20_000 },
    )
    .toContain("bob");
  await bob.page.getByText("Bob queued follow-up").waitFor({ state: "visible", timeout: 15_000 });
  expect(await bob.page.getByTestId("queued-send-now-button").count()).toBe(0);
  expect(await bob.page.getByRole("button", { name: "Stop generation" }).count()).toBe(0);
  expect(await bob.page.getByTestId("team-admin-interrupt-button").count()).toBe(0);

  // Verify browser Notification fired for Alice (creator), NOT for Bob (sender) or Charlie (unrelated non-follower).
  await expect
    .poll(async () => (await alice.notifications()).length, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1);
  const aliceQueuedNotifications = await alice.notifications();
  expect(
    aliceQueuedNotifications.some(
      (n) =>
        n.title.includes('bob queued a message in "Alice running turn"') &&
        n.body.includes("Bob queued follow-up"),
    ),
  ).toBe(true);
  expect(await bob.notifications()).toEqual([]);
  expect(await charlie.notifications()).toEqual([]);

  await alice.setWindowFocused(true);
  await charlie.setWindowFocused(true);
  await bob.setWindowFocused(true);

  // Alice's pending approval was NOT touched or declined by Bob's queued send.
  expect(await alice.page.getByRole("button", { name: /^Approve/ }).count()).toBeGreaterThan(0);

  // Charlie (modo) opens Alice's UNLOCKED running thread:
  // - Sees Bob's queued message with author "bob", NO "Send now", and DOES see explicit "Interrupt"!
  // - When Alice locks the thread, Charlie's "Interrupt" button disappears; when unlocked, it returns!
  const charlieAliceRow = charlie.page
    .locator("aside, [data-sidebar='sidebar']")
    .first()
    .locator("[data-sidebar-row]", { hasText: "Alice running turn" })
    .first();
  await expect
    .poll(async () => (await charlieAliceRow.textContent().catch(() => "")) ?? "", {
      timeout: 20_000,
    })
    .toContain("alice: Alice running turn");
  await charlieAliceRow.focus();
  await charlieAliceRow.press("Enter");
  await expect
    .poll(
      async () =>
        (await charlie.page
          .getByTestId("team-queued-author")
          .textContent()
          .catch(() => "")) ?? "",
      { timeout: 20_000 },
    )
    .toContain("bob");
  expect(await charlie.page.getByTestId("queued-send-now-button").count()).toBe(0);
  const charlieInterruptBtn = charlie.page.getByTestId("team-admin-interrupt-button");
  await charlieInterruptBtn.waitFor({ state: "visible", timeout: 15_000 });
  expect((await charlieInterruptBtn.textContent()) ?? "").toContain("Interrupt");

  // Locking Alice's thread hides explicit Interrupt for modo (Charlie); unlocking restores it.
  const aliceLockBtn = alice.page.getByTestId("team-thread-lock-button");
  await aliceLockBtn.waitFor({ state: "visible", timeout: 15_000 });
  await aliceLockBtn.click();
  await expect
    .poll(async () => await charlie.page.getByTestId("team-admin-interrupt-button").count(), {
      timeout: 15_000,
    })
    .toBe(0);
  await aliceLockBtn.click();
  await charlieInterruptBtn.waitFor({ state: "visible", timeout: 15_000 });

  // Alice (creator!) DOES see Bob's queued message with "bob" pseudo AND DOES see "Send now"!
  await expect
    .poll(
      async () =>
        (await alice.page
          .getByTestId("team-queued-author")
          .textContent()
          .catch(() => "")) ?? "",
      { timeout: 20_000 },
    )
    .toContain("bob");
  await alice.page
    .getByTestId("queued-send-now-button")
    .waitFor({ state: "visible", timeout: 15_000 });

  // 4. Bob starts his own running Supervised thread ("Bob running turn").
  //    Alice (owner) opens Bob's thread, posts a mid-turn message (queues with "alice" pseudo),
  //    sees NO "Send now", DOES see explicit "Interrupt" button!
  await bob.page.getByRole("button", { name: "New thread" }).first().click();
  await bobComposer.waitFor({ state: "visible", timeout: 15_000 });
  await selectSupervisedMode(bob.page);
  await bobComposer.click();
  await bobComposer.fill("Bob running turn");
  await bobComposer.press("Enter");
  await expect
    .poll(
      async () =>
        (await bob.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "",
      { timeout: 20_000 },
    )
    .toContain("bob: Bob running turn");
  await bob.page
    .getByRole("button", { name: "Stop generation" })
    .waitFor({ state: "visible", timeout: 25_000 });
  await bob.page
    .getByRole("button", { name: /^Approve/ })
    .first()
    .waitFor({ state: "visible", timeout: 25_000 });
  const bobThreadId = new URL(bob.page.url()).pathname.split("/").filter(Boolean).at(-1) ?? "";
  expect(bobThreadId.length).toBeGreaterThan(0);

  const aliceBobRow = alice.page
    .locator("aside, [data-sidebar='sidebar']")
    .first()
    .locator("[data-sidebar-row]", { hasText: "Bob running turn" })
    .first();
  await expect
    .poll(async () => (await aliceBobRow.textContent().catch(() => "")) ?? "", { timeout: 20_000 })
    .toContain("bob: Bob running turn");
  await aliceBobRow.focus();
  await aliceBobRow.press("Enter");

  const adminInterruptBtn = alice.page.getByTestId("team-admin-interrupt-button");
  await adminInterruptBtn.waitFor({ state: "visible", timeout: 20_000 });
  expect((await adminInterruptBtn.textContent()) ?? "").toContain("Interrupt");

  await aliceComposer.click();
  await aliceComposer.fill("Owner mid-turn queued note");
  await aliceComposer.press("Enter");
  await expect
    .poll(
      async () =>
        (await alice.page
          .getByTestId("team-queued-author")
          .textContent()
          .catch(() => "")) ?? "",
      { timeout: 20_000 },
    )
    .toContain("alice");
  expect(await alice.page.getByTestId("queued-send-now-button").count()).toBe(0);

  // 5. Plane 1 live agent-injected MCP containment + warm session recycling on author switch:
  //    Switch the Team Server's default model to our MCP Probe ACP agent, run Turn 1 as Alice
  //    and Turn 2 as Bob on the EXACT SAME thread!
  await runPromise(
    Effect.gen(function* () {
      const client = yield* rpcClientForBearer(topology.teamServer.origin, adminBearerToken);
      yield* client["server.updateSettings"]({
        patch: {
          defaultModelSelection: { instanceId: probeInstanceId, model: "default" },
        },
      });
    }).pipe(Effect.scoped),
  );

  // Alice opens a new thread using MCP Probe (Turn 1 -> actingMemberId = alice).
  await alice.page.getByRole("button", { name: "New thread" }).first().click();
  await aliceComposer.waitFor({ state: "visible", timeout: 15_000 });
  await aliceComposer.click();
  await aliceComposer.fill("MCP Probe shared thread");
  await aliceComposer.press("Enter");

  await expect
    .poll(() => readProbeRecords(probeLogPath).length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(1);
  const aliceProbe = readProbeRecords(probeLogPath)[0]!;
  expect(aliceProbe.endpoint).not.toBeNull();
  expect(aliceProbe.authorization).not.toBeNull();

  // Verify Alice's real agent MCP token:
  // - CAN read Staff Only thread
  // - CANNOT promote_to_steer (Send now) on Bob's running thread (strictly creator-only!)
  const aliceReadStaff = await callMcpTool({
    request: alice.page.request,
    endpoint: aliceProbe.endpoint!,
    authorization: aliceProbe.authorization!,
    toolName: "t3_thread_read",
    args: { threadId: staffThreadId },
  });
  if (aliceReadStaff.isError || aliceReadStaff.status !== 200) {
    throw new Error(`aliceReadStaff failed: ${JSON.stringify(aliceReadStaff)}`);
  }

  const aliceListBobQueue = await callMcpTool({
    request: alice.page.request,
    endpoint: aliceProbe.endpoint!,
    authorization: aliceProbe.authorization!,
    toolName: "t3_queue",
    args: { threadId: bobThreadId, action: "list" },
  });
  if (aliceListBobQueue.isError) {
    throw new Error(`aliceListBobQueue failed: ${JSON.stringify(aliceListBobQueue)}`);
  }
  const aliceQueuedOnBobMatch = /"queuedRunId"\s*:\s*"([^"]+)"|"runId"\s*:\s*"([^"]+)"/.exec(
    aliceListBobQueue.text,
  );
  expect(aliceQueuedOnBobMatch).not.toBeNull();
  const bobActiveRunMatch = /"activeRunId"\s*:\s*"([^"]+)"/.exec(aliceListBobQueue.text);
  const alicePromoteOnBob = await callMcpTool({
    request: alice.page.request,
    endpoint: aliceProbe.endpoint!,
    authorization: aliceProbe.authorization!,
    toolName: "t3_queue",
    args: {
      threadId: bobThreadId,
      action: "promote_to_steer",
      queuedRunId: (aliceQueuedOnBobMatch![1] ?? aliceQueuedOnBobMatch![2])!,
      targetRunId: bobActiveRunMatch?.[1] ?? "run-bob-active",
    },
  });
  expect(alicePromoteOnBob.isError).toBe(true);
  expect(alicePromoteOnBob.text).toContain("capability_denied");

  // Release Alice's probe turn 1, wait for it to settle, then Bob sends Turn 2 on the EXACT SAME thread!
  NodeFS.writeFileSync(NodePath.join(projectDir, "mcp-probe-release-1"), "ok", "utf8");
  await expect
    .poll(async () => await alice.page.getByRole("button", { name: "Stop generation" }).count(), {
      timeout: 20_000,
    })
    .toBe(0);

  const bobProbeRow = bob.page
    .locator("aside, [data-sidebar='sidebar']")
    .first()
    .locator("[data-sidebar-row]", { hasText: "MCP Probe shared thread" })
    .first();
  await expect
    .poll(async () => (await bobProbeRow.textContent().catch(() => "")) ?? "", { timeout: 20_000 })
    .toContain("alice: MCP Probe shared thread");
  await bobProbeRow.focus();
  await bobProbeRow.press("Enter");
  await bobComposer.waitFor({ state: "visible", timeout: 15_000 });
  await bobComposer.click();
  await bobComposer.fill("Bob turn 2 on Alice's probe thread");
  await bobComposer.press("Enter");

  await expect
    .poll(() => readProbeRecords(probeLogPath).length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(2);
  const bobProbe = readProbeRecords(probeLogPath)[1]!;
  expect(bobProbe.endpoint).not.toBeNull();
  expect(bobProbe.authorization).not.toBeNull();

  // Warm session MUST have recycled (new PID + rotated MCP token), and Alice's previous token MUST be revoked!
  expect(bobProbe.pid).not.toBe(aliceProbe.pid);
  expect(bobProbe.authorization).not.toBe(aliceProbe.authorization);
  const revokedReplay = await callMcpTool({
    request: alice.page.request,
    endpoint: aliceProbe.endpoint!,
    authorization: aliceProbe.authorization!,
    toolName: "t3_thread_list",
    args: {},
  });
  expect(revokedReplay.status).toBe(401);

  // Verify Bob's real agent MCP token (running inside Alice's thread!) obeys BOB's regular permissions:
  const bobReadStaff = await callMcpTool({
    request: alice.page.request,
    endpoint: bobProbe.endpoint!,
    authorization: bobProbe.authorization!,
    toolName: "t3_thread_read",
    args: { threadId: staffThreadId },
  });
  expect(bobReadStaff.isError).toBe(true);
  expect(bobReadStaff.text).toContain("capability_denied");

  const bobListThreads = await callMcpTool({
    request: alice.page.request,
    endpoint: bobProbe.endpoint!,
    authorization: bobProbe.authorization!,
    toolName: "t3_thread_list",
    args: {},
  });
  expect(bobListThreads.isError).toBe(false);
  expect(bobListThreads.text).not.toContain(staffThreadId);
  expect(bobListThreads.text).toContain(aliceThreadId);

  const bobInterruptAlice = await callMcpTool({
    request: alice.page.request,
    endpoint: bobProbe.endpoint!,
    authorization: bobProbe.authorization!,
    toolName: "t3_thread_interrupt",
    args: { threadId: aliceThreadId },
  });
  expect(bobInterruptAlice.isError).toBe(true);
  expect(bobInterruptAlice.text).toContain("capability_denied");

  // Even passing stop: true on Alice's thread is denied for regular Bob.
  const bobStopAlice = await callMcpTool({
    request: alice.page.request,
    endpoint: bobProbe.endpoint!,
    authorization: bobProbe.authorization!,
    toolName: "t3_thread_interrupt",
    args: { threadId: aliceThreadId, stop: true },
  });
  expect(bobStopAlice.isError).toBe(true);
  expect(bobStopAlice.text).toContain("capability_denied");

  // Restricted Staff-only thread issues and PR links must not leak to regular Bob.
  const bobListStaffIssues = await callMcpTool({
    request: alice.page.request,
    endpoint: bobProbe.endpoint!,
    authorization: bobProbe.authorization!,
    toolName: "list_thread_issues",
    args: { threadId: staffThreadId },
  });
  expect(bobListStaffIssues.isError).toBe(true);

  const bobListStaffPrs = await callMcpTool({
    request: alice.page.request,
    endpoint: bobProbe.endpoint!,
    authorization: bobProbe.authorization!,
    toolName: "list_thread_pull_requests",
    args: { threadId: staffThreadId },
  });
  expect(bobListStaffPrs.isError).toBe(true);

  const bobCreateProject = await callMcpTool({
    request: alice.page.request,
    endpoint: bobProbe.endpoint!,
    authorization: bobProbe.authorization!,
    toolName: "t3_project_create",
    args: { title: "Unauthorized MCP Project" },
  });
  expect(bobCreateProject.isError).toBe(true);
  expect(bobCreateProject.text).toContain("capability_denied");

  // Release Bob's probe turn 2 cleanly.
  NodeFS.writeFileSync(NodePath.join(projectDir, "mcp-probe-release-2"), "ok", "utf8");

  // Now Alice returns to Bob's running thread and clicks explicit Interrupt -> stops Bob's turn live!
  await aliceBobRow.focus();
  await aliceBobRow.press("Enter");
  await adminInterruptBtn.waitFor({ state: "visible", timeout: 20_000 });
  await adminInterruptBtn.click();
  await expect
    .poll(async () => await alice.page.getByTestId("team-admin-interrupt-button").count(), {
      timeout: 25_000,
    })
    .toBe(0);

  // 6. Plane 2 live --team-hub-only server verification:
  //    Boot a real t3server with --team-hub-only and verify its environment descriptor advertises
  //    capabilities.teamHubOnly === true.
  const hubRunId = await Effect.runPromise(
    SecureRandom.SecureRandom.pipe(
      Effect.flatMap((r) => r.uuidV4()),
      Effect.provide(NodeCrypto.layer),
    ),
  );
  const hubHome = `${TEAM_SCENARIOS_HOME}/hub-only-${hubRunId}`;
  const hubPort = await Effect.runPromise(
    NetService.NetService.pipe(
      Effect.flatMap((net) => net.reserveLoopbackPort()),
      Effect.provide(NetService.layer),
    ),
  );
  const hubServer = await startT3ServerProcess({
    home: hubHome,
    port: hubPort,
    devUrl: alice.origin,
    allowedOrigins: [alice.origin],
    devAuthToken: `${hubRunId.replaceAll("-", "")}${hubRunId.replaceAll("-", "")}`,
    environmentLabel: "Team Hub Only",
    extraArgs: ["--team-hub-only"],
  });
  try {
    const wellKnownRes = await alice.page.request.get(
      `${hubServer.origin}/.well-known/t3/environment`,
    );
    expect(wellKnownRes.status()).toBe(200);
    const descriptor = (await wellKnownRes.json()) as {
      readonly capabilities?: { readonly teamHubOnly?: boolean };
    };
    expect(descriptor.capabilities?.teamHubOnly).toBe(true);
  } finally {
    await hubServer.stop();
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(hubHome, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }
});
