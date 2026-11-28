// @effect-diagnostics nodeBuiltinImport:off -- The scenario registers a local ACP probe script and reads its JSONL log.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
  makeTeamProviderInstanceId,
  parseTeamJoinLink,
} from "@t3tools/contracts";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { TEAM_APP_DIR } from "../../e2e.team.config.ts";
import { rpcClient, runPromise } from "../t3.ts";
import { startTeamTopology, type TeamMemberHandle } from "./topology.ts";
import { openTeamInviteForm, selectTeamSettingsTab } from "./ui-helpers.ts";

// Minimal ACP agent that captures its injected member-bound T3 MCP endpoint and bearer token
// so we can invoke real /mcp tools as a regular member against Team Server.
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

async function callBearerRpc<A, E>(
  origin: string,
  bearerToken: string,
  fn: (client: Effect.Success<ReturnType<typeof rpcClientForBearer>>) => Effect.Effect<A, E>,
): Promise<
  { readonly ok: true; readonly result: A } | { readonly ok: false; readonly error: string }
> {
  return await runPromise(
    Effect.gen(function* () {
      const client = yield* rpcClientForBearer(origin, bearerToken);
      const value = yield* fn(client);
      return { ok: true as const, result: value };
    }).pipe(
      Effect.scoped,
      Effect.catch((error) =>
        Effect.succeed({
          ok: false as const,
          error: error instanceof Error ? `${error.name}: ${error.message}` : JSON.stringify(error),
        }),
      ),
    ),
  );
}

async function callMcpTool(input: {
  readonly request: TeamMemberHandle["page"]["request"];
  readonly endpoint: string;
  readonly authorization: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}): Promise<{ readonly status: number; readonly isError: boolean; readonly text: string }> {
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
        clientInfo: { name: "team-m5-e2e", version: "1.0.0" },
      },
    },
  });
  if (initRes.status() !== 200) {
    return { status: initRes.status(), isError: true, text: await initRes.text() };
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
  const webJoinLink = await createInviteLink(input);
  const parsedUrl = new URL(webJoinLink);
  const joinUrl = `${input.invitee.origin}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;

  await input.invitee.page.goto(joinUrl, { waitUntil: "domcontentloaded" });
  await input.invitee.page
    .getByTestId("team-join-preview")
    .waitFor({ state: "visible", timeout: 15_000 });
  await input.invitee.page.getByTestId("team-join-submit").click();
  await input.invitee.page
    .getByTestId("team-colleagues-toggle")
    .waitFor({ state: "visible", timeout: 20_000 });
}

async function redeemBearerToken(input: {
  readonly request: TeamMemberHandle["page"]["request"];
  readonly teamServerOrigin: string;
  readonly joinLink: string;
  readonly pseudo: string;
}): Promise<string> {
  const parsed = parseTeamJoinLink(input.joinLink);
  expect(parsed).not.toBeNull();
  const res = await input.request.post(`${input.teamServerOrigin}/api/team/invites/redeem`, {
    headers: { "content-type": "application/json" },
    data: { token: parsed!.token, pseudo: input.pseudo },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { readonly accessToken: string };
  return body.accessToken;
}

async function waitForAssistantTurnSettled(
  page: TeamMemberHandle["page"],
  minAssistantMessages: number,
  label: string,
) {
  try {
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
  } catch (error) {
    const url = page.url();
    const userMessages = await page.locator('[data-message-role="user"]').allTextContents();
    const assistantCount = await page.locator('[data-message-role="assistant"]').count();
    const alerts = await page.locator('[role="alert"], [data-slot="toast"]').allTextContents();
    throw new Error(
      `waitForAssistantTurnSettled(${label}) failed (url=${url}, assistantCount=${assistantCount}, expected>=${minAssistantMessages}, userMessages=${JSON.stringify(userMessages)}, alerts=${JSON.stringify(alerts)}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function selectDraftEnvironment(
  page: TeamMemberHandle["page"],
  targetLabelPattern: RegExp,
  forbiddenLabel?: string,
) {
  const hostPicker = page.locator('[data-composer-shortcut="composer.host"]').first();
  await hostPicker.waitFor({ state: "visible", timeout: 15_000 });
  await hostPicker.click();
  if (forbiddenLabel) {
    expect(await page.getByRole("option", { name: new RegExp(forbiddenLabel, "i") }).count()).toBe(
      0,
    );
  }
  await page.getByRole("option", { name: targetLabelPattern }).first().click();
}

test("enforces Milestone 5 team projects, local-to-team sync, absolute local boundary, restricted remote environments, thread notes, empty prompts, TOCTOU re-anchoring, and mid-turn queueing", async ({
  app,
}) => {
  await using topology = await startTeamTopology({
    viteUrl: app.baseUrl ?? "",
    extraRemoteEnvironments: 1,
    members: [
      { pseudo: "alice", role: "owner" },
      { pseudo: "bob", role: "regular" },
      { pseudo: "dave", role: "regular" },
    ],
  });

  const alice = topology.member("alice");
  const bob = topology.member("bob");
  const dave = topology.member("dave");
  const restrictedRemote = topology.extraRemoteEnvironments[0]!;
  const sharedOriginUrl = "https://github.com/acme/team-m5-shared.git";

  // 1. Seed matching git repositories (identical origin URL -> identical RepositoryIdentity) on Team Server & Bob's local machine.
  const teamProjectDir = await topology.teamServer.project(
    "shared-m5-repo",
    {
      "README.md": "# Team M5 Shared\n",
      "mcp-probe-agent.mjs": MCP_PROBE_ACP,
    },
    { gitOriginUrl: sharedOriginUrl },
  );
  await bob.project(
    "shared-m5-repo",
    { "README.md": "# Bob Local Clone\n" },
    { gitOriginUrl: sharedOriginUrl },
  );

  // Register the MCP Probe ACP agent on Team Server so we can verify real MCP env-ACL enforcement.
  const probeInstanceId = ProviderInstanceId.make("mcp-probe");
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
              commandArgs: [NodePath.join(teamProjectDir, "mcp-probe-agent.mjs")],
            },
          },
        },
      });
    }).pipe(Effect.scoped),
  );

  // 2. Alice pairs with Team Server, selects it, initializes the team, and invites Bob (regular), Dave (regular), plus API tokens for direct RPC checks.
  await alice.pairWithRemoteServer({
    host: topology.teamServer.origin,
    pairingToken: topology.teamServer.pairingToken,
  });
  await alice.open("/settings/teams");
  await alice.page.getByTestId("team-server-select").click();
  await alice.page.getByRole("option", { name: /Team Server/ }).click();
  await alice.page.getByTestId("team-init-name").fill("Milestone 5 Team");
  await alice.page.getByTestId("team-init-pseudo").fill("alice");
  await alice.page.getByTestId("team-init-submit").click();
  await alice.page.getByTestId("team-member-alice").waitFor({ state: "visible", timeout: 15_000 });

  await createInviteAndJoin({ inviter: alice, invitee: bob, roleLabel: "Regular", pseudo: "bob" });
  await createInviteAndJoin({
    inviter: alice,
    invitee: dave,
    roleLabel: "Regular",
    pseudo: "dave",
  });

  // Mint authenticated Bearer tokens for direct typed WS RPC checks (regular Eve + admin Clara).
  const eveJoinLink = await createInviteLink({
    inviter: alice,
    roleLabel: "Regular",
    pseudo: "eve",
  });
  const eveBearerToken = await redeemBearerToken({
    request: alice.page.request,
    teamServerOrigin: topology.teamServer.origin,
    joinLink: eveJoinLink,
    pseudo: "eve",
  });
  const claraJoinLink = await createInviteLink({
    inviter: alice,
    roleLabel: "Admin",
    pseudo: "clara",
  });
  const claraBearerToken = await redeemBearerToken({
    request: alice.page.request,
    teamServerOrigin: topology.teamServer.origin,
    joinLink: claraJoinLink,
    pseudo: "clara",
  });

  // Register team providers (strict M6 isolation requires team:<teamId>:* providers on team-assigned projects).
  const claraInitialState = await callBearerRpc(
    topology.teamServer.origin,
    claraBearerToken,
    (client) => client["team.getState"]({}),
  );
  if (!claraInitialState.ok || !claraInitialState.result.team) {
    throw new Error("Expected initialized team state for Clara");
  }
  const teamId = claraInitialState.result.team.id;
  const teamReplaySourceId = ProviderInstanceId.make("team-dev-replay");
  const teamReplayVirtualId = makeTeamProviderInstanceId(teamId, teamReplaySourceId);
  const teamProbeVirtualId = makeTeamProviderInstanceId(teamId, probeInstanceId);
  const devReplayAgentPath = NodePath.resolve(
    TEAM_APP_DIR,
    "apps/server/scripts/dev-replay-agent.ts",
  );

  const upsertReplayRes = await callBearerRpc(
    topology.teamServer.origin,
    claraBearerToken,
    (client) =>
      client["team.upsertProvider"]({
        providerInstanceId: teamReplaySourceId,
        driver: ProviderDriverKind.make("acpRegistry"),
        displayName: "Team Replay (dev)",
        deliveryStrategy: "proxy",
        upstreamBaseUrl: "http://127.0.0.1:1",
        config: {
          source: "local",
          commandPath: process.execPath,
          commandArgs: [devReplayAgentPath],
        },
        enabled: true,
      }),
  );
  if (!upsertReplayRes.ok) {
    throw new Error(`team.upsertProvider(team-dev-replay) failed: ${upsertReplayRes.error}`);
  }

  // 3. Alice attaches extra remote environment ("GPU Runner") restricted to owner & admin ONLY via Settings -> Teams -> Environments.
  await selectTeamSettingsTab(alice.page, "access");
  await alice.page
    .getByTestId("team-env-attach-open")
    .waitFor({ state: "visible", timeout: 15_000 });
  await alice.page.getByTestId("team-env-attach-open").click();
  await alice.page.getByTestId("team-env-attach-url").fill(restrictedRemote.origin);
  await alice.page.getByTestId("team-env-attach-code").fill(restrictedRemote.pairingToken);
  await alice.page.getByTestId("team-env-attach-name").fill("GPU Runner");
  const attachForm = alice.page.getByTestId("team-env-attach-form");
  await attachForm.getByText("Modo").click();
  await attachForm.getByText("Regular").click();
  await alice.page.getByTestId("team-env-attach-submit").click();
  await alice.page
    .getByTestId(`team-env-row-${restrictedRemote.environmentId}`)
    .waitFor({ state: "visible", timeout: 20_000 });

  // Verify regular Bob does NOT see GPU Runner in Settings -> Teams -> Environments.
  await bob.open("/settings/teams");
  await selectTeamSettingsTab(bob.page, "access");
  await bob.page
    .getByTestId("team-environments-list")
    .waitFor({ state: "visible", timeout: 15_000 });
  await expect
    .poll(
      async () =>
        await bob.page.getByTestId(`team-env-row-${restrictedRemote.environmentId}`).count(),
      { timeout: 10_000 },
    )
    .toBe(0);

  // Direct authenticated WS RPC check: regular Eve does NOT see GPU Runner in team.getState
  // and cannot connect to GPU Runner via peerLinks.pairClient.
  const eveTeamState = await callBearerRpc(topology.teamServer.origin, eveBearerToken, (client) =>
    client["team.getState"]({}),
  );
  if (!eveTeamState.ok) {
    throw new Error(`eve team.getState failed: ${eveTeamState.error}`);
  }
  expect(
    (eveTeamState.result.environments ?? []).some(
      (env) => env.environmentId === restrictedRemote.environmentId,
    ),
  ).toBe(false);

  const evePairRestricted = await callBearerRpc(
    topology.teamServer.origin,
    eveBearerToken,
    (client) =>
      client["peerLinks.pairClient"]({
        environmentId: EnvironmentId.make(restrictedRemote.environmentId),
      }),
  );
  expect(evePairRestricted.ok).toBe(false);

  // Admin Clara CAN see GPU Runner in peerLinks.list.
  const claraPeerList = await callBearerRpc(
    topology.teamServer.origin,
    claraBearerToken,
    (client) => client["peerLinks.list"]({}),
  );
  if (!claraPeerList.ok) {
    throw new Error(`clara peerLinks.list failed: ${claraPeerList.error}`);
  }
  expect(
    claraPeerList.result.links.some(
      (link) => link.environmentId === restrictedRemote.environmentId,
    ),
  ).toBe(true);

  // 4. Alice assigns the shared project to the Team via Project Settings.
  await alice.open("/settings/projects");
  const projectNavButton = alice.page.getByRole("button", { name: /shared-m5-repo/i }).first();
  await projectNavButton.waitFor({ state: "visible", timeout: 15_000 });
  await projectNavButton.click();
  await alice.page
    .getByTestId("project-team-select")
    .waitFor({ state: "visible", timeout: 15_000 });
  await alice.page.getByTestId("project-team-select").click();
  await alice.page.getByRole("option", { name: "Milestone 5 Team" }).click();
  await expect
    .poll(async () => (await alice.page.getByTestId("project-team-select").textContent()) ?? "", {
      timeout: 10_000,
    })
    .toContain("Milestone 5 Team");

  // 5. Bob enables desktop notifications and starts a thread on his LOCAL environment for the team-assigned project.
  await bob.open("/settings/general");
  const notificationSelect = bob.page.getByLabel("Thread notifications");
  await notificationSelect.waitFor({ state: "visible", timeout: 15_000 });
  await notificationSelect.click();
  await bob.page.getByRole("option", { name: "Notifications only" }).click();

  // Wait for Bob's local server to provision the synced virtual team provider (`team:<teamId>:team-dev-replay`).
  await expect
    .poll(
      async () =>
        await runPromise(
          Effect.gen(function* () {
            const client = yield* rpcClient(bob.home, bob.localServerOrigin);
            const config = yield* client["server.getConfig"]({});
            const found = config.providers.find(
              (provider) => provider.instanceId === teamReplayVirtualId,
            );
            if (!found) {
              return `missing(ids=${config.providers.map((p) => `${p.instanceId}:${p.status}`).join(",")})`;
            }
            return found.status === "ready" ? "ready" : `${found.status}:${found.message ?? ""}`;
          }).pipe(Effect.scoped),
        ),
      { timeout: 25_000, interval: 500 },
    )
    .toBe("ready");

  await bob.open("/");
  await bob.setWindowFocused(false);
  await bob.clearNotifications();
  await bob.page.getByRole("button", { name: "New thread" }).first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await bob.page.getByRole("button", { name: "New thread" }).first().click();
  // Verify the new-thread environment picker offers Bob's local env & Team Server, and hides restricted GPU Runner.
  await selectDraftEnvironment(bob.page, /Local \(bob\)/i, "GPU Runner");
  const bobEditor = bob.page.locator('[contenteditable="true"]').first();
  await bobEditor.waitFor({ state: "visible", timeout: 15_000 });
  await bobEditor.click();
  await bobEditor.fill("Local turn one from Bob laptop");
  await bobEditor.press("Enter");
  await waitForAssistantTurnSettled(bob.page, 1, "bob-local-turn-1");

  // Extract Bob's local threadId from Bob's URL (`/<localEnvId>/<threadId>`).
  await expect
    .poll(() => bob.page.url(), { timeout: 15_000 })
    .toMatch(new RegExp(`/${bob.localEnvironmentId}/[^/]+$`));
  const bobThreadId = ThreadId.make(bob.page.url().split("/").at(-1)!);

  // Wait for Bob's local thread to mirror into Team Server's threadAttributions before Alice opens it.
  await expect
    .poll(
      async () => {
        const state = await callBearerRpc(topology.teamServer.origin, claraBearerToken, (client) =>
          client["team.getState"]({}),
        );
        if (!state.ok) return `err:${state.error}`;
        const attr = state.result.threadAttributions.find((a) => a.threadId === bobThreadId);
        if (!attr) {
          return `missing(teamProjects=${JSON.stringify(state.result.teamProjects)}, attrs=${state.result.threadAttributions.length})`;
        }
        return attr.isLocalSynced ? "synced" : "not-local-synced";
      },
      { timeout: 20_000, interval: 500 },
    )
    .toBe("synced");

  // 6. Alice (owner) sees Bob's local-synced thread on the Team Server, sees the inaccessible-environment banner,
  //    cannot execute on Bob's laptop (enforced server-side for even owner/admin), and leaves a note via in-place Note Mode.
  await alice.open("/");
  await alice.page.getByTestId("team-colleagues-toggle").click();
  await alice.open(`/${topology.teamServer.environmentId}/${bobThreadId}`);
  await alice.page
    .getByTestId("team-inaccessible-env-banner")
    .waitFor({ state: "visible", timeout: 20_000 });

  await expect
    .poll(
      async () =>
        (await alice.page
          .locator('[data-message-role="user"]')
          .allTextContents()
          .then((list) => list.join("\n"))) ?? "",
      { timeout: 15_000 },
    )
    .toContain("Local turn one from Bob laptop");
  await alice.page
    .getByTestId("team-fork-thread-button")
    .waitFor({ state: "visible", timeout: 10_000 });
  await alice.page
    .getByTestId("team-leave-note-button")
    .waitFor({ state: "visible", timeout: 10_000 });

  // Verify EVEN an authenticated Team Admin (Clara) attempting direct WS RPC dispatch onto Bob's local-synced thread is rejected by server!
  const hijackAttempt = await callBearerRpc(
    topology.teamServer.origin,
    claraBearerToken,
    (client) =>
      client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "message.dispatch",
        commandId: CommandId.make("cmd-hijack-bob-local"),
        threadId: bobThreadId,
        messageId: MessageId.make("msg-hijack-bob-local"),
        createdBy: "user",
        creationSource: "web",
        text: "Unauthorized execution attempt",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      }),
  );
  expect(hijackAttempt.ok).toBe(false);
  expect(hijackAttempt.ok ? "" : hijackAttempt.error).toMatch(
    /local|environment|authorization|forbidden/i,
  );

  // Also verify metadata continuation and terminalOpen are blocked on Bob's local-synced thread!
  const continuationHijack = await callBearerRpc(
    topology.teamServer.origin,
    claraBearerToken,
    (client) =>
      client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "thread.metadata.update",
        commandId: CommandId.make("cmd-continuation-hijack-bob-local"),
        threadId: bobThreadId,
        continuation: {
          messageId: MessageId.make("msg-continuation-hijack-bob-local"),
          text: "Sneaky continuation hijack",
        },
      }),
  );
  expect(continuationHijack.ok).toBe(false);

  const terminalHijack = await callBearerRpc(
    topology.teamServer.origin,
    claraBearerToken,
    (client) =>
      client["terminal.open"]({
        threadId: bobThreadId,
        terminalId: "term-hijack-bob-local",
        cwd: teamProjectDir,
        cols: 80,
        rows: 24,
      }),
  );
  expect(terminalHijack.ok).toBe(false);

  // Verify author-only delete while pending (and failure once accepted/not-author).
  const tempNoteRes = await callBearerRpc(topology.teamServer.origin, eveBearerToken, (client) =>
    client["team.createThreadNote"]({
      threadId: bobThreadId,
      body: "Temporary pending note to delete",
    }),
  );
  if (!tempNoteRes.ok) {
    throw new Error(`tempNoteRes failed: ${tempNoteRes.error}`);
  }
  const wrongAuthorDelete = await callBearerRpc(
    topology.teamServer.origin,
    claraBearerToken,
    (client) => client["team.deleteThreadNote"]({ noteId: tempNoteRes.result.id }),
  );
  expect(wrongAuthorDelete.ok).toBe(false);
  const authorDelete = await callBearerRpc(topology.teamServer.origin, eveBearerToken, (client) =>
    client["team.deleteThreadNote"]({ noteId: tempNoteRes.result.id }),
  );
  expect(authorDelete.ok).toBe(true);
  expect(authorDelete.ok ? authorDelete.result.deleted : false).toBe(true);

  // Alice enters in-place Note Mode (no modal!) and sends an owner-authored note.
  await alice.page.getByTestId("team-leave-note-button").click();
  await alice.page
    .getByTestId("team-note-mode-banner")
    .waitFor({ state: "visible", timeout: 5_000 });
  await alice.page
    .locator('[data-team-note-mode="true"]')
    .waitFor({ state: "visible", timeout: 5_000 });
  const aliceEditor = alice.page.locator('[contenteditable="true"]').first();
  await aliceEditor.click();
  await aliceEditor.fill("Owner suggestion from Alice");
  await alice.page.getByTestId("team-note-composer-submit").click();
  await alice.page
    .getByText("Owner suggestion from Alice")
    .waitFor({ state: "visible", timeout: 15_000 });

  // 7. Dave (regular) opens Bob's local-synced thread and leaves a regular-authored note.
  await dave.open(`/${topology.teamServer.environmentId}/${bobThreadId}`);
  await dave.page
    .getByTestId("team-inaccessible-env-banner")
    .waitFor({ state: "visible", timeout: 15_000 });
  await dave.page.getByTestId("team-leave-note-button").click();
  const daveEditor = dave.page.locator('[contenteditable="true"]').first();
  await daveEditor.click();
  await daveEditor.fill("Regular suggestion from Dave");
  await dave.page.getByTestId("team-note-composer-submit").click();
  await dave.page
    .getByText("Regular suggestion from Dave")
    .waitFor({ state: "visible", timeout: 15_000 });

  // 8. Bob sees BOTH notes inline on his local thread, receives owner notification,
  //    sees 1-line pending-notes bar when typing a prompt, gets 1-click Edit/Accept for owner Alice
  //    vs explicit confirmation dialog with exact full text for regular Dave, edits Alice's note,
  //    and submits an EMPTY prompt ("")!
  await bob.page
    .getByText("Owner suggestion from Alice")
    .waitFor({ state: "visible", timeout: 15_000 });
  await bob.page
    .getByText("Regular suggestion from Dave")
    .waitFor({ state: "visible", timeout: 15_000 });
  await expect
    .poll(async () => (await bob.notifications()).length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);

  // Typing a prompt while pending notes exist shows the compact 1-line bar disabling Send.
  await bobEditor.click();
  await bob.page.keyboard.type("Draft blocked by pending notes");
  await bob.page
    .getByTestId("team-pending-notes-bar")
    .waitFor({ state: "visible", timeout: 10_000 });
  await bob.page.keyboard.press("Control+A");
  await bob.page.keyboard.press("Backspace");

  const aliceNoteCardTestId = await bob.page
    .locator('[data-testid^="team-thread-note-"]')
    .filter({ hasText: "Owner suggestion from Alice" })
    .first()
    .getAttribute("data-testid");
  expect(aliceNoteCardTestId).toBeTruthy();
  const aliceNoteCard = bob.page.getByTestId(aliceNoteCardTestId!);

  const daveNoteCardTestId = await bob.page
    .locator('[data-testid^="team-thread-note-"]')
    .filter({ hasText: "Regular suggestion from Dave" })
    .first()
    .getAttribute("data-testid");
  expect(daveNoteCardTestId).toBeTruthy();
  const daveNoteCard = bob.page.getByTestId(daveNoteCardTestId!);

  // Owner-authored note (Alice): clicking Edit + Save & Accept skips confirmation modal!
  await aliceNoteCard.locator('[data-testid^="team-note-edit-"]').first().click();
  const editTextarea = aliceNoteCard.locator('[data-testid^="team-note-edit-input-"]');
  await editTextarea.fill("Owner suggestion edited by Bob");
  await aliceNoteCard.locator('[data-testid^="team-note-edit-save-"]').click();
  expect(await bob.page.getByTestId("team-note-confirm-dialog").count()).toBe(0);
  await expect
    .poll(async () => (await aliceNoteCard.textContent()) ?? "", { timeout: 10_000 })
    .toContain("Owner suggestion edited by Bob");
  await expect
    .poll(async () => (await aliceNoteCard.textContent()) ?? "", { timeout: 10_000 })
    .toContain("Accepted");

  // Regular-authored note (Dave): clicking Accept MUST open explicit confirmation dialog with exact full text!
  await daveNoteCard.locator('[data-testid^="team-note-accept-"]').first().click();
  await bob.page
    .getByTestId("team-note-confirm-dialog")
    .waitFor({ state: "visible", timeout: 10_000 });
  expect(
    ((await bob.page.getByTestId("team-note-confirm-exact-text").textContent()) ?? "").trim(),
  ).toBe("Regular suggestion from Dave");
  await bob.page.getByTestId("team-note-confirm-submit").click();
  await expect
    .poll(async () => await bob.page.getByTestId("team-note-confirm-dialog").count(), {
      timeout: 10_000,
    })
    .toBe(0);
  await expect
    .poll(async () => (await daveNoteCard.textContent()) ?? "", { timeout: 10_000 })
    .toContain("Accepted");

  // Submit EMPTY prompt ("") with the 2 accepted notes!
  await bobEditor.click();
  await bob.page.keyboard.press("Enter");
  await waitForAssistantTurnSettled(bob.page, 2, "bob-local-turn-2-empty-prompt-with-notes");
  const userMessagesText = await bob.page.locator('[data-message-role="user"]').allTextContents();
  const turn2Text = userMessagesText.at(-1) ?? "";
  expect(turn2Text).toContain("[Note from alice (edited & approved by bob)]:");
  expect(turn2Text).toContain("Owner suggestion edited by Bob");
  expect(turn2Text).toContain("[Note from dave (approved by bob)]:");
  expect(turn2Text).toContain("Regular suggestion from Dave");

  // 9. Rejected note & absolute boundary on consumeAcceptedNotes:
  //    Clara (admin) leaves a note on Bob's local thread; Clara cannot consume notes on Bob's local thread,
  //    and Bob can reject it so it stays muted/collapsed in chronological order.
  const claraNoteRes = await callBearerRpc(topology.teamServer.origin, claraBearerToken, (client) =>
    client["team.createThreadNote"]({
      threadId: bobThreadId,
      body: "Rejected note from Clara",
    }),
  );
  if (!claraNoteRes.ok) {
    throw new Error(`clara createThreadNote failed: ${claraNoteRes.error}`);
  }
  const claraNote = claraNoteRes.result;

  // Clara (admin) cannot consume notes on Bob's local-synced thread!
  const claraConsumeRes = await callBearerRpc(
    topology.teamServer.origin,
    claraBearerToken,
    (client) =>
      client["team.consumeAcceptedNotes"]({
        threadId: bobThreadId,
        targetTurnId: "turn-clara-blocked",
        acceptedNotes: [{ noteId: claraNote.id, contentHash: claraNote.originalContentHash }],
      }),
  );
  expect(claraConsumeRes.ok).toBe(false);

  const claraNoteLocator = bob.page
    .locator('[data-testid^="team-thread-note-"]')
    .filter({ hasText: "Rejected note from Clara" })
    .first();
  await claraNoteLocator.waitFor({ state: "visible", timeout: 15_000 });
  const claraNoteCardTestId = await claraNoteLocator.getAttribute("data-testid");
  expect(claraNoteCardTestId).toBeTruthy();
  const claraNoteCard = bob.page.getByTestId(claraNoteCardTestId!);
  await claraNoteCard.locator('[data-testid^="team-note-reject-"]').click();
  await expect
    .poll(async () => (await claraNoteCard.textContent()) ?? "", { timeout: 10_000 })
    .toContain("Rejected");

  // 10. Mid-turn note approval into native dashed queue (`QueuedRunsControl`) with creator-only `Send now`:
  //     Configure Bob's local server to Replay (dev) `approval` + `approval-required` so a new local
  //     thread stays deterministically active waiting on tool approval while Alice leaves a mid-turn note.
  await runPromise(
    Effect.gen(function* () {
      const client = yield* rpcClient(bob.home, bob.localServerOrigin);
      yield* client["server.updateSettings"]({
        patch: {
          defaultModelSelection: {
            instanceId: teamReplayVirtualId,
            model: "approval",
          },
          defaultRuntimeMode: "approval-required",
        },
      });
    }).pipe(Effect.scoped),
  );
  // Wait for Bob's local server to provision the synced virtual team provider (`team:<teamId>:team-dev-replay`).
  await expect
    .poll(
      async () =>
        await runPromise(
          Effect.gen(function* () {
            const client = yield* rpcClient(bob.home, bob.localServerOrigin);
            const config = yield* client["server.getConfig"]({});
            const found = config.providers.find(
              (provider) => provider.instanceId === teamReplayVirtualId,
            );
            if (!found) {
              return `missing(ids=${config.providers.map((p) => `${p.instanceId}:${p.status}`).join(",")})`;
            }
            return found.status === "ready" ? "ready" : `${found.status}:${found.message ?? ""}`;
          }).pipe(Effect.scoped),
        ),
      { timeout: 25_000, interval: 500 },
    )
    .toBe("ready");

  await bob.open("/");
  await bob.page.getByRole("button", { name: "New thread" }).first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await bob.page.getByRole("button", { name: "New thread" }).first().click();
  await selectDraftEnvironment(bob.page, /Local \(bob\)/i, "GPU Runner");
  const bobPausedEditor = bob.page.locator('[contenteditable="true"]').first();
  await bobPausedEditor.waitFor({ state: "visible", timeout: 15_000 });
  await bobPausedEditor.click();
  await bobPausedEditor.fill("Active local turn waiting on approval");
  await bobPausedEditor.press("Enter");
  await bob.page
    .getByRole("button", { name: "Stop generation" })
    .waitFor({ state: "visible", timeout: 15_000 });
  await expect
    .poll(() => bob.page.url(), { timeout: 15_000 })
    .toMatch(new RegExp(`/${bob.localEnvironmentId}/[^/]+$`));
  const bobPausedThreadId = ThreadId.make(bob.page.url().split("/").at(-1)!);

  // Wait for Bob's paused local thread to sync to Team Server, then Clara leaves a mid-turn note on it.
  await expect
    .poll(
      async () => {
        const state = await callBearerRpc(topology.teamServer.origin, claraBearerToken, (client) =>
          client["team.getState"]({}),
        );
        if (!state.ok) return false;
        return state.result.threadAttributions.some(
          (a) => a.threadId === bobPausedThreadId && a.isLocalSynced,
        );
      },
      { timeout: 20_000, interval: 500 },
    )
    .toBe(true);

  const midTurnNoteCreate = await callBearerRpc(
    topology.teamServer.origin,
    claraBearerToken,
    (client) =>
      client["team.createThreadNote"]({
        threadId: bobPausedThreadId,
        body: "Mid-turn queued note from Clara",
      }),
  );
  if (!midTurnNoteCreate.ok) {
    throw new Error(`midTurnNoteCreate failed: ${midTurnNoteCreate.error}`);
  }

  // Bob sees "Accept & Queue" on Clara's note while his turn is running, clicks it, and sees it in QueuedRunsControl with Send now!
  const midTurnNoteCard = bob.page
    .locator('[data-testid^="team-thread-note-"]')
    .filter({ hasText: "Mid-turn queued note from Clara" })
    .first();
  await midTurnNoteCard.waitFor({ state: "visible", timeout: 15_000 });
  const acceptQueueBtn = midTurnNoteCard.locator('[data-testid^="team-note-accept-"]').first();
  await expect
    .poll(async () => (await acceptQueueBtn.textContent()) ?? "", { timeout: 10_000 })
    .toContain("Accept & Queue");
  await acceptQueueBtn.click();
  await bob.page
    .getByTestId("queued-send-now-button")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });

  // 11. Alice clicks "Fork this thread" from Bob's local-synced thread and forks onto the accessible Team Server environment!
  await alice.page.getByTestId("team-fork-thread-button").click();
  await alice.page
    .getByTestId("team-fork-thread-dialog")
    .waitFor({ state: "visible", timeout: 10_000 });
  await alice.page.getByTestId(`team-fork-env-${topology.teamServer.environmentId}`).click();
  await expect.poll(() => alice.page.url(), { timeout: 20_000 }).not.toContain(bobThreadId);
  await expect
    .poll(
      async () =>
        (await alice.page.locator('[data-message-role="user"]').first().textContent()) ?? "",
      { timeout: 15_000 },
    )
    .toContain("[Forked from");

  // 12. TOCTOU concurrent note arrival race on Alice's forked Team Server thread:
  //     Eve creates Note 1 & Note 2; Clara (admin) approves ONLY Note 1 (while Note 2 stays pending,
  //     simulating Note 2 arriving concurrently in flight), then consumes acceptedNotes=[Note 1]
  //     and verifies Note 2 is NOT included, stays pending, and is re-anchored to the new turn!
  const forkedThreadId = ThreadId.make(
    new URL(alice.page.url()).pathname.split("/").filter(Boolean).at(-1)!,
  );
  const toctouNote1Res = await callBearerRpc(topology.teamServer.origin, eveBearerToken, (client) =>
    client["team.createThreadNote"]({
      threadId: forkedThreadId,
      body: "TOCTOU approved note",
    }),
  );
  if (!toctouNote1Res.ok) {
    throw new Error(`toctouNote1 failed: ${toctouNote1Res.error}`);
  }
  const toctouNote1 = toctouNote1Res.result;

  const toctouNote2Res = await callBearerRpc(topology.teamServer.origin, eveBearerToken, (client) =>
    client["team.createThreadNote"]({
      threadId: forkedThreadId,
      body: "TOCTOU concurrent race note",
    }),
  );
  if (!toctouNote2Res.ok) {
    throw new Error(`toctouNote2 failed: ${toctouNote2Res.error}`);
  }
  const toctouNote2 = toctouNote2Res.result;

  const approveNote1 = await callBearerRpc(topology.teamServer.origin, claraBearerToken, (client) =>
    client["team.resolveThreadNote"]({
      noteId: toctouNote1.id,
      status: "accepted",
      expectedContentHash: toctouNote1.originalContentHash,
    }),
  );
  if (!approveNote1.ok) {
    throw new Error(`approveNote1 failed: ${approveNote1.error}`);
  }

  const toctouConsume = await callBearerRpc(
    topology.teamServer.origin,
    claraBearerToken,
    (client) =>
      client["team.consumeAcceptedNotes"]({
        threadId: forkedThreadId,
        targetTurnId: "turn-toctou-e2e-2",
        acceptedNotes: [{ noteId: toctouNote1.id, contentHash: toctouNote1.originalContentHash }],
      }),
  );
  if (!toctouConsume.ok) {
    throw new Error(`toctouConsume failed: ${toctouConsume.error}`);
  }
  expect(toctouConsume.result.formattedPromptPrefix).toContain("TOCTOU approved note");
  expect(toctouConsume.result.formattedPromptPrefix).not.toContain("TOCTOU concurrent race note");
  expect(toctouConsume.result.consumedNotes.map((n) => n.id)).toEqual([toctouNote1.id]);
  expect(toctouConsume.result.reanchoredNoteIds).toContain(toctouNote2.id);

  const listedNotesAfterToctou = await callBearerRpc(
    topology.teamServer.origin,
    claraBearerToken,
    (client) => client["team.listThreadNotes"]({ threadId: forkedThreadId }),
  );
  if (!listedNotesAfterToctou.ok) {
    throw new Error(`listThreadNotes failed: ${listedNotesAfterToctou.error}`);
  }
  const note1After = listedNotesAfterToctou.result.notes.find((n) => n.id === toctouNote1.id);
  const note2After = listedNotesAfterToctou.result.notes.find((n) => n.id === toctouNote2.id);
  expect(note1After?.status).toBe("consumed");
  expect(note1After?.includedInTurnId).toBe("turn-toctou-e2e-2");
  expect(note2After?.status).toBe("pending");
  expect(note2After?.anchorTurnId).toBe("turn-toctou-e2e-2");

  // Also verify real local-environment normal prompt send (0 accepted notes) re-anchors a concurrently
  // arriving pending note on Bob's local thread!
  const localRaceNoteRes = await callBearerRpc(
    topology.teamServer.origin,
    eveBearerToken,
    (client) =>
      client["team.createThreadNote"]({
        threadId: bobThreadId,
        body: "Local normal-send concurrent note",
      }),
  );
  if (!localRaceNoteRes.ok) {
    throw new Error(`localRaceNoteRes failed: ${localRaceNoteRes.error}`);
  }
  const initialLocalRaceAnchor = localRaceNoteRes.result.anchorTurnId;
  // Bob dispatches a normal local turn (0 accepted notes) directly on his local server while the
  // note stays pending, and the Team Server re-anchors the pending note to the new mirrored run!
  const bobNormalLocalMsgId = MessageId.make("msg-bob-local-normal-toctou");
  await runPromise(
    Effect.gen(function* () {
      const client = yield* rpcClient(bob.home, bob.localServerOrigin);
      yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "message.dispatch",
        commandId: CommandId.make("cmd-bob-local-normal-toctou"),
        threadId: bobThreadId,
        messageId: bobNormalLocalMsgId,
        createdBy: "user",
        creationSource: "web",
        text: "Bob normal local prompt without accepted notes",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
    }).pipe(Effect.scoped),
  );
  await expect
    .poll(
      async () => {
        const listed = await callBearerRpc(topology.teamServer.origin, claraBearerToken, (client) =>
          client["team.listThreadNotes"]({ threadId: bobThreadId }),
        );
        if (!listed.ok) return false;
        const found = listed.result.notes.find((n) => n.id === localRaceNoteRes.result.id);
        return Boolean(
          found &&
          found.status === "pending" &&
          found.anchorTurnId !== null &&
          found.anchorTurnId !== initialLocalRaceAnchor,
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  // 13. Real MCP environment-ACL check on Team Server:
  //     Register MCP Probe as a team provider, switch Team Server default model to it, let regular Dave
  //     start a Team Server thread, and verify Dave's member-bound MCP token hides `restrictedRemote`,
  //     denies `t3_environment_read` on it, and denies `t3_thread_send` onto Bob's local-synced thread!
  const upsertProbeRes = await callBearerRpc(
    topology.teamServer.origin,
    claraBearerToken,
    (client) =>
      client["team.upsertProvider"]({
        providerInstanceId: probeInstanceId,
        driver: ProviderDriverKind.make("acpRegistry"),
        displayName: "Team MCP Probe",
        deliveryStrategy: "proxy",
        upstreamBaseUrl: "http://127.0.0.1:1",
        config: {
          source: "local",
          commandPath: process.execPath,
          commandArgs: [NodePath.join(teamProjectDir, "mcp-probe-agent.mjs")],
        },
        enabled: true,
      }),
  );
  if (!upsertProbeRes.ok) {
    throw new Error(`team.upsertProvider(mcp-probe) failed: ${upsertProbeRes.error}`);
  }
  await expect
    .poll(
      async () =>
        await runPromise(
          Effect.gen(function* () {
            const client = yield* rpcClientForBearer(topology.teamServer.origin, claraBearerToken);
            const config = yield* client["server.getConfig"]({});
            return config.providers.some(
              (provider) =>
                provider.instanceId === teamProbeVirtualId && provider.status === "ready",
            );
          }).pipe(Effect.scoped),
        ),
      { timeout: 25_000, interval: 500 },
    )
    .toBe(true);
  const probeLogPath = NodePath.join(teamProjectDir, "mcp-probe-turns.jsonl");
  await runPromise(
    Effect.gen(function* () {
      const client = yield* rpcClientForBearer(topology.teamServer.origin, claraBearerToken);
      yield* client["server.updateSettings"]({
        patch: {
          defaultModelSelection: { instanceId: teamProbeVirtualId, model: "default" },
        },
      });
    }).pipe(Effect.scoped),
  );

  await dave.open("/");
  await dave.page.getByRole("button", { name: "New thread" }).first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await dave.page.getByRole("button", { name: "New thread" }).first().click();
  const daveMainEditor = dave.page.locator('[contenteditable="true"]').first();
  await daveMainEditor.waitFor({ state: "visible", timeout: 15_000 });
  await daveMainEditor.click();
  await daveMainEditor.fill("Dave MCP env ACL check");
  await daveMainEditor.press("Enter");

  await expect
    .poll(() => readProbeRecords(probeLogPath).length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(1);
  const daveProbe = readProbeRecords(probeLogPath)[0]!;
  expect(daveProbe.endpoint).toBeTruthy();
  expect(daveProbe.authorization).toBeTruthy();

  const linksRes = await callMcpTool({
    request: dave.page.request,
    endpoint: daveProbe.endpoint!,
    authorization: daveProbe.authorization!,
    toolName: "t3_environment_links",
    args: {},
  });
  expect(linksRes.status).toBe(200);
  expect(linksRes.isError).toBe(false);
  expect(linksRes.text).not.toContain(restrictedRemote.environmentId);

  const readRestrictedRes = await callMcpTool({
    request: dave.page.request,
    endpoint: daveProbe.endpoint!,
    authorization: daveProbe.authorization!,
    toolName: "t3_environment_read",
    args: { environmentId: restrictedRemote.environmentId },
  });
  expect(readRestrictedRes.isError).toBe(true);

  const sendToLocalRes = await callMcpTool({
    request: dave.page.request,
    endpoint: daveProbe.endpoint!,
    authorization: daveProbe.authorization!,
    toolName: "t3_thread_send",
    args: { threadId: bobThreadId, message: "MCP hijack attempt on Bob local thread" },
  });
  expect(sendToLocalRes.isError).toBe(true);

  NodeFS.writeFileSync(NodePath.join(teamProjectDir, "mcp-probe-release-1"), "ok");
});
