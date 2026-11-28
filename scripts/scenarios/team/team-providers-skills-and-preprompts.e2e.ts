// @effect-diagnostics nodeBuiltinImport:off -- The scenario seeds isolated HOME files, registers a Fake-LLM ACP probe script, and scans Bob's T3_HOME for zero key leakage.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  CommandId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderDriverKind,
  ProviderInstanceId,
  TeamSkillSlug,
  ThreadId,
  WsRpcGroup,
  makeTeamProviderInstanceId,
  parseTeamJoinLink,
} from "@t3tools/contracts";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { rpcClient, runPromise } from "../t3.ts";
import { startTeamTopology, type TeamMemberHandle } from "./topology.ts";
import { openTeamInviteForm, selectTeamSettingsTab } from "./ui-helpers.ts";

// Lightweight ACP agent that routes every turn through `T3_TEAM_PROXY_URL` using `T3_TEAM_PROXY_TOKEN`
// (proving zero company keys reach the member's local environment) and reports which pre-prompt tags
// were delivered on each turn.
const FAKE_LLM_PROXY_ACP_AGENT = `
import { createInterface } from "node:readline";

let sessionId = "fake-llm-session-" + process.pid;
let turnNumber = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { id, method, params } = JSON.parse(line);
  if (id === undefined || method === undefined) continue;
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: {} },
        authMethods: [],
        agentInfo: { name: "Team Fake LLM Proxy Agent", version: "1.0.0" },
      },
    });
  } else if (method === "session/new") {
    send({ id, result: { sessionId } });
  } else if (method === "session/load") {
    if (params && typeof params.sessionId === "string") sessionId = params.sessionId;
    send({ id, result: {} });
  } else if (method === "session/prompt") {
    turnNumber += 1;
    const blocks = Array.isArray(params?.prompt) ? params.prompt : [];
    const promptText = blocks
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .join("\\n");
    const proxyUrl = process.env.T3_TEAM_PROXY_URL || "";
    const proxyToken = process.env.T3_TEAM_PROXY_TOKEN || "";
    const res = await fetch(proxyUrl.replace(/\\/+$/, "") + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + proxyToken,
      },
      body: JSON.stringify({ turn: turnNumber, prompt: promptText }),
    });
    const bodyText = await res.text();
    const hasThreadMarker = promptText.includes("TEAM_THREAD_MARKER_M6");
    const hasTurnMarker = promptText.includes("TEAM_TURN_MARKER_M6");
    const envHasSecret = Object.values(process.env).some(
      (value) => typeof value === "string" && value.includes("TEAM_SECRET_KEY_M6"),
    );
    const replyText =
      res.status === 200
        ? [
            "TURN=" + turnNumber,
            "STATUS=200",
            "THREAD_MARKER=" + hasThreadMarker,
            "TURN_MARKER=" + hasTurnMarker,
            "ENV_HAS_SECRET=" + envHasSecret,
            "BODY=" + bodyText,
          ].join(" ")
        : "PROXY_ERROR status=" + res.status + " body=" + bodyText;

    send({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: replyText },
        },
      },
    });
    send({ id, result: { stopReason: "end_turn" } });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

const rpcClientForBearer = Effect.fn("scenario.m6.rpcClientForBearer")(function* (
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

function directoryContainsSecret(rootDir: string, secrets: ReadonlyArray<string>): string | null {
  const stack: Array<string> = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: ReadonlyArray<NodeFS.Dirent>;
    try {
      entries = NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = NodePath.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        try {
          const content = NodeFS.readFileSync(fullPath, "utf8");
          for (const secret of secrets) {
            if (content.includes(secret)) {
              return `${fullPath} contains ${secret}`;
            }
          }
        } catch {
          // Skip transient/unreadable files
        }
      }
    }
  }
  return null;
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
    const alerts = await page.locator('[role="alert"], [data-slot="toast"]').allTextContents();
    throw new Error(
      `waitForAssistantTurnSettled(${label}) failed (url=${url}, alerts=${JSON.stringify(alerts)}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function selectDraftEnvironment(page: TeamMemberHandle["page"], targetLabelPattern: RegExp) {
  const hostPicker = page.locator('[data-composer-shortcut="composer.host"]').first();
  await hostPicker.waitFor({ state: "visible", timeout: 15_000 });
  await hostPicker.click();
  await page.getByRole("option", { name: targetLabelPattern }).first().click();
}

test("enforces Milestone 6 zero-config team providers, strict isolation, proxy zero-leakage, ephemeral OAuth lease & 403 revocation, and pure-Markdown team skills & pre-prompts", async ({
  app,
}) => {
  await using topology = await startTeamTopology({
    viteUrl: app.baseUrl ?? "",
    fakeTeamLlm: true,
    isolateMemberHome: true,
    members: [
      { pseudo: "alice", role: "owner" },
      { pseudo: "charlie", role: "modo" },
      { pseudo: "bob", role: "regular" },
    ],
  });

  const fakeTeamLlm = topology.fakeTeamLlm!;
  const alice = topology.member("alice");
  const charlie = topology.member("charlie");
  const bob = topology.member("bob");
  const sharedOriginUrl = "https://github.com/acme/team-m6-shared.git";

  // Seed Bob's isolated personal ~/.gemini with a personal GEMINI.md and two personal skills
  // (one unique, one colliding on slug `team-review` to verify team precedence without mutating ~/.gemini).
  const bobUserHome = NodePath.join(bob.home, "user-home");
  const bobPersonalGeminiMd = NodePath.join(bobUserHome, ".gemini", "GEMINI.md");
  const bobPersonalOnlySkill = NodePath.join(
    bobUserHome,
    ".gemini",
    "config",
    "skills",
    "personal-only",
    "SKILL.md",
  );
  const bobPersonalShadowedSkill = NodePath.join(
    bobUserHome,
    ".gemini",
    "config",
    "skills",
    "team-review",
    "SKILL.md",
  );
  NodeFS.mkdirSync(NodePath.dirname(bobPersonalOnlySkill), { recursive: true });
  NodeFS.mkdirSync(NodePath.dirname(bobPersonalShadowedSkill), { recursive: true });
  NodeFS.writeFileSync(bobPersonalGeminiMd, "# Bob personal rules untouched\n", "utf8");
  NodeFS.writeFileSync(
    bobPersonalOnlySkill,
    "---\nname: personal-only\ndescription: Bob personal skill\n---\nPersonal only body\n",
    "utf8",
  );
  NodeFS.writeFileSync(
    bobPersonalShadowedSkill,
    "---\nname: team-review\ndescription: Bob personal colliding version\n---\nPersonal colliding body\n",
    "utf8",
  );

  // Seed shared git repository on Team Server & Bob's local machine + write the Fake LLM ACP agent script.
  const teamProjectDir = await topology.teamServer.project(
    "shared-m6-repo",
    {
      "README.md": "# Team M6 Shared\n",
      "fake-llm-acp-agent.mjs": FAKE_LLM_PROXY_ACP_AGENT,
    },
    { gitOriginUrl: sharedOriginUrl },
  );
  const fakeAgentPath = NodePath.join(teamProjectDir, "fake-llm-acp-agent.mjs");
  await bob.project(
    "shared-m6-repo",
    { "README.md": "# Bob Local M6 Clone\n" },
    { gitOriginUrl: sharedOriginUrl },
  );

  // 1. Alice pairs with Team Server, initializes the team, and invites Charlie (modo) & Bob (regular)
  //    plus headless API tokens for direct RPC / HTTP verification.
  await alice.pairWithRemoteServer({
    host: topology.teamServer.origin,
    pairingToken: topology.teamServer.pairingToken,
  });
  await alice.open("/settings/teams");
  await alice.page.getByTestId("team-server-select").click();
  await alice.page.getByRole("option", { name: /Team Server/ }).click();
  await alice.page.getByTestId("team-init-name").fill("Milestone 6 Team");
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

  const adminTokenLink = await createInviteLink({
    inviter: alice,
    roleLabel: "Admin",
    pseudo: "admin_api",
  });
  const adminBearer = await redeemBearerToken({
    request: alice.page.request,
    teamServerOrigin: topology.teamServer.origin,
    joinLink: adminTokenLink,
    pseudo: "admin_api",
  });
  const modoTokenLink = await createInviteLink({
    inviter: alice,
    roleLabel: "Modo",
    pseudo: "modo_api",
  });
  const modoBearer = await redeemBearerToken({
    request: alice.page.request,
    teamServerOrigin: topology.teamServer.origin,
    joinLink: modoTokenLink,
    pseudo: "modo_api",
  });
  const regularTokenLink = await createInviteLink({
    inviter: alice,
    roleLabel: "Regular",
    pseudo: "bob_api",
  });
  const bobApiBearer = await redeemBearerToken({
    request: alice.page.request,
    teamServerOrigin: topology.teamServer.origin,
    joinLink: regularTokenLink,
    pseudo: "bob_api",
  });

  const teamStateRes = await callBearerRpc(topology.teamServer.origin, adminBearer, (client) =>
    client["team.getState"]({}),
  );
  if (!teamStateRes.ok || !teamStateRes.result.team) {
    throw new Error("Expected initialized team");
  }
  const teamId = teamStateRes.result.team.id;
  const bobMember = teamStateRes.result.members.find((m) => m.pseudo === "bob");
  const bobApiMember = teamStateRes.result.members.find((m) => m.pseudo === "bob_api");
  expect(bobMember).toBeDefined();
  expect(bobApiMember).toBeDefined();

  // 2. Admin-only team providers:
  //    - Admin configures proxy (`team-fake-llm`), token-lease (`team-oauth-agy`), and `remote-only` (`team-cursor-remote`).
  //    - Modo and regular members are REJECTED on provider mutations (both `team.upsertProvider` and `server.updateSettings`).
  const modoProviderAttempt = await callBearerRpc(
    topology.teamServer.origin,
    modoBearer,
    (client) =>
      client["team.upsertProvider"]({
        providerInstanceId: ProviderInstanceId.make("unauthorized-provider"),
        driver: ProviderDriverKind.make("acpRegistry"),
        displayName: "Unauthorized",
        deliveryStrategy: "proxy",
        upstreamBaseUrl: fakeTeamLlm.origin,
        apiKey: "should-fail",
      }),
  );
  expect(modoProviderAttempt.ok).toBe(false);

  const bobSettingsProviderAttempt = await callBearerRpc(
    topology.teamServer.origin,
    bobApiBearer,
    (client) =>
      client["server.updateSettings"]({
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: ProviderInstanceId.make("bob-personal"),
          instance: { driver: ProviderDriverKind.make("codex"), enabled: true },
        },
      }),
  );
  expect(bobSettingsProviderAttempt.ok).toBe(false);

  // Configure `team-fake-llm` (`proxy`) with company secret key (stays ONLY on Team Server!).
  const fakeLlmSourceId = ProviderInstanceId.make("team-fake-llm");
  const fakeLlmVirtualId = makeTeamProviderInstanceId(teamId, fakeLlmSourceId);
  const upsertProxyRes = await callBearerRpc(topology.teamServer.origin, adminBearer, (client) =>
    client["team.upsertProvider"]({
      providerInstanceId: fakeLlmSourceId,
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: "Team Fake LLM",
      deliveryStrategy: "proxy",
      upstreamBaseUrl: fakeTeamLlm.origin,
      apiKey: fakeTeamLlm.expectedApiKey,
      config: {
        source: "local",
        commandPath: process.execPath,
        commandArgs: [fakeAgentPath],
      },
      enabled: true,
    }),
  );
  if (!upsertProxyRes.ok) {
    throw new Error(`team.upsertProvider(team-fake-llm) failed: ${upsertProxyRes.error}`);
  }

  // Configure `team-oauth-agy` (`token-lease`) holding the sole company OAuth refresh_token on Team Server.
  const oauthAgySourceId = ProviderInstanceId.make("team-oauth-agy");
  const upsertLeaseRes = await callBearerRpc(topology.teamServer.origin, adminBearer, (client) =>
    client["team.upsertProvider"]({
      providerInstanceId: oauthAgySourceId,
      driver: ProviderDriverKind.make("antigravity"),
      displayName: "Team Antigravity",
      deliveryStrategy: "token-lease",
      oauthAccessToken: "initial-near-expiry",
      oauthRefreshToken: "COMPANY_MASTER_REFRESH_SECRET",
      oauthExpiresAt: "2020-01-01T00:00:00.000Z",
      oauthTokenEndpoint: `${fakeTeamLlm.origin}/oauth/token`,
      oauthClientId: "team-client-id",
      enabled: true,
    }),
  );
  if (!upsertLeaseRes.ok) {
    throw new Error(`team.upsertProvider(team-oauth-agy) failed: ${upsertLeaseRes.error}`);
  }

  // Configure `team-cursor-remote` (`remote-only`) via the real Settings -> Teams -> Providers UI as Alice!
  await selectTeamSettingsTab(alice.page, "providers");
  await alice.page
    .getByTestId("team-provider-add-open")
    .waitFor({ state: "visible", timeout: 15_000 });
  await alice.page.getByTestId("team-provider-add-open").click();
  await alice.page
    .getByTestId("team-provider-id-input")
    .waitFor({ state: "visible", timeout: 15_000 });
  await alice.page.getByTestId("team-provider-id-input").fill("team-cursor-remote");
  await alice.page.getByTestId("team-provider-name-input").fill("Team Cursor Remote");
  await alice.page.getByTestId("team-provider-strategy-select").click();
  await alice.page.getByRole("option", { name: "Remote environments only" }).click();
  await alice.page.getByTestId("team-provider-save-submit").click();
  await alice.page
    .getByTestId("team-provider-row-team-cursor-remote")
    .waitFor({ state: "visible", timeout: 15_000 });

  // Verify regular Bob sees team providers read-only (no add/save form) in Settings -> Teams -> Providers.
  await bob.open("/settings/teams");
  await selectTeamSettingsTab(bob.page, "providers");
  await bob.page
    .getByTestId("team-provider-row-team-fake-llm")
    .waitFor({ state: "visible", timeout: 15_000 });
  expect(await bob.page.getByTestId("team-provider-add-open").count()).toBe(0);
  expect(await bob.page.getByTestId("team-provider-form").count()).toBe(0);

  // 3. Assign `shared-m6-repo` to Milestone 6 Team via Project Settings.
  await alice.open("/settings/projects");
  const projectNavButton = alice.page.getByRole("button", { name: /shared-m6-repo/i }).first();
  await projectNavButton.waitFor({ state: "visible", timeout: 15_000 });
  await projectNavButton.click();
  await alice.page
    .getByTestId("project-team-select")
    .waitFor({ state: "visible", timeout: 15_000 });
  await alice.page.getByTestId("project-team-select").click();
  await alice.page.getByRole("option", { name: "Milestone 6 Team" }).click();
  await expect
    .poll(async () => (await alice.page.getByTestId("project-team-select").textContent()) ?? "", {
      timeout: 10_000,
    })
    .toContain("Milestone 6 Team");

  // 4. Team Skills & Pre-Prompts (modo+ CRUD + strict pure-Markdown boundary):
  //    - Executable `.sh` script reference is REJECTED server-side.
  const badScriptAttempt = await callBearerRpc(topology.teamServer.origin, modoBearer, (client) =>
    client["team.upsertSkill"]({
      slug: TeamSkillSlug.make("bad-exec-skill"),
      providerDriver: "*",
      skillMd: "---\nname: bad-exec-skill\ndescription: Bad\n---\nBody",
      references: [{ path: "scripts/pwn.sh", content: "echo pwned" }],
    }),
  );
  expect(badScriptAttempt.ok).toBe(false);

  //    - Regular Bob is REJECTED on skill/pre-prompt writes.
  const bobSkillAttempt = await callBearerRpc(topology.teamServer.origin, bobApiBearer, (client) =>
    client["team.upsertSkill"]({
      slug: TeamSkillSlug.make("bob-unauth"),
      providerDriver: "*",
      skillMd: "---\nname: bob-unauth\ndescription: No\n---\nBody",
    }),
  );
  expect(bobSkillAttempt.ok).toBe(false);

  //    - Charlie (`modo`) creates pure-Markdown skill `/team-review`, a `"thread"` pre-prompt, and a `"turn"` pre-prompt via the UI!
  await charlie.open("/settings/teams");
  await selectTeamSettingsTab(charlie.page, "providers");
  await charlie.page
    .getByTestId("team-providers-list")
    .waitFor({ state: "visible", timeout: 15_000 });
  expect(await charlie.page.getByTestId("team-provider-add-open").count()).toBe(0);
  expect(await charlie.page.getByTestId("team-provider-form").count()).toBe(0);

  await selectTeamSettingsTab(charlie.page, "skills");
  await charlie.page
    .getByTestId("team-skill-add-open")
    .waitFor({ state: "visible", timeout: 15_000 });
  await charlie.page.getByTestId("team-skill-add-open").click();
  await charlie.page
    .getByTestId("team-skill-slug-input")
    .waitFor({ state: "visible", timeout: 15_000 });
  await charlie.page.getByTestId("team-skill-slug-input").fill("team-review");
  await charlie.page
    .getByTestId("team-skill-md-input")
    .fill(
      "---\nname: team-review\ndescription: Team authoritative review checklist\n---\n# Team Review\n",
    );
  await charlie.page.getByTestId("team-skill-save-submit").click();
  await charlie.page
    .getByTestId("team-skill-row-team-review")
    .waitFor({ state: "visible", timeout: 15_000 });

  await charlie.page.getByTestId("team-preprompt-add-open").click();
  await charlie.page.getByTestId("team-preprompt-name-input").fill("Thread Rules");
  await charlie.page
    .getByTestId("team-preprompt-content-input")
    .fill("TEAM_THREAD_MARKER_M6: Follow team coding standards.");
  await charlie.page.getByTestId("team-preprompt-save-submit").click();
  await expect
    .poll(
      async () => (await charlie.page.getByTestId("team-preprompts-list").textContent()) ?? "",
      {
        timeout: 15_000,
      },
    )
    .toContain("Thread Rules");

  await charlie.page.getByTestId("team-preprompt-add-open").click();
  await charlie.page.getByTestId("team-preprompt-name-input").fill("Turn Safety Rule");
  await charlie.page.getByTestId("team-preprompt-scope-select").click();
  await charlie.page.getByRole("option", { name: /Every turn/i }).click();
  await charlie.page
    .getByTestId("team-preprompt-content-input")
    .fill("TEAM_TURN_MARKER_M6: Never expose company credentials.");
  await charlie.page.getByTestId("team-preprompt-save-submit").click();
  await expect
    .poll(
      async () => (await charlie.page.getByTestId("team-preprompts-list").textContent()) ?? "",
      {
        timeout: 15_000,
      },
    )
    .toContain("Turn Safety Rule");

  // 5. Wait for Bob's local server to receive the synced virtual team provider (`team:<teamId>:team-fake-llm`)
  //    AND materialized team assets (via `TeamLocalThreadSyncCoordinator` + `GET /api/team/assets?since=`)!
  await expect
    .poll(
      async () =>
        await runPromise(
          Effect.gen(function* () {
            const client = yield* rpcClient(bob.home, bob.localServerOrigin);
            const config = yield* client["server.getConfig"]({});
            const found = config.providers.find(
              (provider) => provider.instanceId === fakeLlmVirtualId,
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

  // Verify strict isolation on Bob's local server: attempting to launch a thread on Bob's team-assigned
  // local project using personal `devReplay` is REJECTED server-side!
  const bobShellEvent = await runPromise(
    Effect.gen(function* () {
      const client = yield* rpcClient(bob.home, bob.localServerOrigin);
      const first = yield* Stream.runHead(client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
      return Option.getOrThrow(first);
    }).pipe(Effect.scoped),
  );
  const bobProjects = bobShellEvent.kind === "snapshot" ? bobShellEvent.snapshot.projects : [];
  const bobLocalProject = bobProjects.find((p) => p.title === "shared-m6-repo");
  expect(bobLocalProject).toBeDefined();

  const personalLeakAttempt = await runPromise(
    Effect.gen(function* () {
      const client = yield* rpcClient(bob.home, bob.localServerOrigin);
      return yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "thread.create",
        commandId: CommandId.make("cmd-m6-personal-leak-attempt"),
        threadId: ThreadId.make("thread-m6-personal-leak"),
        projectId: bobLocalProject!.id,
        title: "Personal leak attempt",
        createdBy: "user",
        creationSource: "web",
        branch: null,
        worktreePath: null,
        modelSelection: {
          instanceId: ProviderInstanceId.make("devReplay"),
          model: "multi-turn",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
    }).pipe(
      Effect.scoped,
      Effect.map(() => ({ ok: true as const })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error: String(error) })),
    ),
  );
  expect(personalLeakAttempt.ok).toBe(false);
  expect(personalLeakAttempt.ok ? "" : personalLeakAttempt.error).toMatch(
    /team|isolated|provider/i,
  );

  // 6. Bob runs 2 local turns on `shared-m6-repo` with ZERO local provider setup!
  await bob.open("/");
  await bob.page.getByRole("button", { name: "New thread" }).first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await bob.page.getByRole("button", { name: "New thread" }).first().click();
  await selectDraftEnvironment(bob.page, /Local \(bob\)/i);

  const bobEditor = bob.page.locator('[contenteditable="true"]').first();
  await bobEditor.waitFor({ state: "visible", timeout: 15_000 });
  await bobEditor.click();
  await bobEditor.fill("Hello Team Proxy Turn 1");
  await bobEditor.press("Enter");
  await waitForAssistantTurnSettled(bob.page, 1, "bob-m6-turn-1");

  const assistantMessagesAfterT1 = await bob.page
    .locator('[data-message-role="assistant"]')
    .allTextContents();
  const turn1Reply = assistantMessagesAfterT1.at(-1) ?? "";
  expect(turn1Reply).toContain("STATUS=200");
  expect(turn1Reply).toContain("FAKE_TEAM_LLM_OK");
  expect(turn1Reply).toContain("THREAD_MARKER=true");
  expect(turn1Reply).toContain("TURN_MARKER=true");
  expect(turn1Reply).toContain("ENV_HAS_SECRET=false");

  // Turn 2: `"turn"` pre-prompt MUST still be injected; `"thread"` generic ACP pre-prompt is Turn-1 only!
  await bobEditor.click();
  await bobEditor.fill("Hello Team Proxy Turn 2");
  await bobEditor.press("Enter");
  await waitForAssistantTurnSettled(bob.page, 2, "bob-m6-turn-2");

  const assistantMessagesAfterT2 = await bob.page
    .locator('[data-message-role="assistant"]')
    .allTextContents();
  const turn2Reply = assistantMessagesAfterT2.at(-1) ?? "";
  expect(turn2Reply).toContain("STATUS=200");
  expect(turn2Reply).toContain("THREAD_MARKER=false");
  expect(turn2Reply).toContain("TURN_MARKER=true");
  expect(turn2Reply).toContain("ENV_HAS_SECRET=false");

  // Verify Fake Team LLM server received BOTH requests authenticated with `TEAM_SECRET_KEY_M6`!
  const llmRequests = fakeTeamLlm.requests();
  expect(llmRequests.length).toBeGreaterThanOrEqual(2);
  for (const req of llmRequests) {
    expect(req.authorization).toBe(`Bearer ${fakeTeamLlm.expectedApiKey}`);
  }

  // Verify centralized per-member usage accounting on the Team Server recorded Bob's proxy requests!
  const usageRes = await callBearerRpc(topology.teamServer.origin, adminBearer, (client) =>
    client["team.listProviderUsage"]({}),
  );
  if (!usageRes.ok) {
    throw new Error(`team.listProviderUsage failed: ${usageRes.error}`);
  }
  expect(
    usageRes.result.usage.some(
      (entry) =>
        entry.memberId === bobMember!.id &&
        entry.providerInstanceId === fakeLlmSourceId &&
        entry.requestCount >= 2,
    ),
  ).toBe(true);

  // 7. Verify isolated profile materialization & personal ~/.gemini preservation on Bob's laptop!
  expect(NodeFS.readFileSync(bobPersonalGeminiMd, "utf8")).toBe("# Bob personal rules untouched\n");
  expect(NodeFS.readFileSync(bobPersonalShadowedSkill, "utf8")).toContain(
    "Bob personal colliding version",
  );
  const antigravityProfilesRoot = NodePath.join(bob.home, "userdata", "providers", "antigravity");
  const findFileRecursively = (root: string, relativeSuffix: string): string | null => {
    if (!NodeFS.existsSync(root)) return null;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      const candidate = NodePath.join(dir, relativeSuffix);
      if (NodeFS.existsSync(candidate)) return candidate;
      for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) stack.push(NodePath.join(dir, entry.name));
      }
    }
    return null;
  };
  let teamGeminiMdPath: string | null = null;
  await expect
    .poll(
      () => {
        teamGeminiMdPath = findFileRecursively(antigravityProfilesRoot, "GEMINI.md");
        return teamGeminiMdPath !== null;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const agyProfileDir = NodePath.dirname(teamGeminiMdPath!);
  const teamSkillMdPath = NodePath.join(agyProfileDir, "team-skills", "team-review", "SKILL.md");
  const teamGeminiMd = NodeFS.readFileSync(teamGeminiMdPath!, "utf8");
  expect(teamGeminiMd).toContain("TEAM_THREAD_MARKER_M6");
  expect(teamGeminiMd).not.toContain("TEAM_TURN_MARKER_M6");
  expect(NodeFS.readFileSync(teamSkillMdPath, "utf8")).toContain(
    "Team authoritative review checklist",
  );

  // 8. Ephemeral OAuth lease (`POST /api/team/provider-lease/:id`) + instant `403` revocation cutoff!
  const bobSyncTokenRes = await callBearerRpc(topology.teamServer.origin, bobApiBearer, (client) =>
    client["team.issueLocalSyncToken"]({}),
  );
  if (!bobSyncTokenRes.ok) {
    throw new Error(`team.issueLocalSyncToken failed: ${bobSyncTokenRes.error}`);
  }
  const bobSyncToken = bobSyncTokenRes.result.token;

  const leaseRes = await bob.page.request.post(
    `${topology.teamServer.origin}/api/team/provider-lease/${oauthAgySourceId}`,
    {
      headers: {
        authorization: `Bearer ${bobSyncToken}`,
        "content-type": "application/json",
      },
      data: {},
    },
  );
  expect(leaseRes.status()).toBe(200);
  const leaseRaw = await leaseRes.text();
  expect(leaseRaw).toContain("leased-ephemeral-access-");
  expect(leaseRaw).not.toContain("COMPANY_MASTER_REFRESH_SECRET");
  expect(fakeTeamLlm.oauthRefreshHits()).toBeGreaterThanOrEqual(1);

  // ZERO-LEAKAGE INVARIANT: Recursively scan Bob's entire `T3_HOME` (`bob.home`) and assert
  // NEITHER `TEAM_SECRET_KEY_M6` NOR `COMPANY_MASTER_REFRESH_SECRET` exists anywhere on disk!
  const leakFound = directoryContainsSecret(bob.home, [
    fakeTeamLlm.expectedApiKey,
    "COMPANY_MASTER_REFRESH_SECRET",
  ]);
  expect(leakFound).toBeNull();

  // Admin suspends `bob_api` -> proxy, lease, and delta assets endpoints IMMEDIATELY return `403 team_access_revoked`!
  const suspendRes = await callBearerRpc(topology.teamServer.origin, adminBearer, (client) =>
    client["team.updateMemberStatus"]({
      memberId: bobApiMember!.id,
      status: "suspended",
    }),
  );
  expect(suspendRes.ok).toBe(true);

  const revokedProxyRes = await bob.page.request.post(
    `${topology.teamServer.origin}/api/team/provider-proxy/${fakeLlmSourceId}/v1/chat/completions`,
    {
      headers: {
        authorization: `Bearer ${bobSyncToken}`,
        "content-type": "application/json",
      },
      data: { prompt: "after-revoke" },
    },
  );
  expect(revokedProxyRes.status()).toBe(403);
  expect(await revokedProxyRes.text()).toContain("team_access_revoked");

  const revokedLeaseRes = await bob.page.request.post(
    `${topology.teamServer.origin}/api/team/provider-lease/${oauthAgySourceId}`,
    {
      headers: {
        authorization: `Bearer ${bobSyncToken}`,
        "content-type": "application/json",
      },
      data: {},
    },
  );
  expect(revokedLeaseRes.status()).toBe(403);

  const revokedAssetsRes = await bob.page.request.get(
    `${topology.teamServer.origin}/api/team/assets?since=0`,
    {
      headers: {
        authorization: `Bearer ${bobSyncToken}`,
      },
    },
  );
  expect(revokedAssetsRes.status()).toBe(403);
});
