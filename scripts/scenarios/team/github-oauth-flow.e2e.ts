// @effect-diagnostics nodeBuiltinImport:off -- Spawns git/gh probe ACP agent and inspects bare repo commits.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { rpcClient, runPromise } from "../t3.ts";
import { startTeamTopology, type TeamMemberHandle } from "./topology.ts";
import {
  confirmDestructiveActionDialog,
  openTeamInviteForm,
  selectTeamSettingsTab,
} from "./ui-helpers.ts";

const GITHUB_OAUTH_PROBE_ACP = `
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const logPath = join(process.cwd(), "github-oauth-probe-turns.jsonl");
let sessionId = "github-oauth-probe-" + process.pid;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");

const waitForRelease = (turnNum) =>
  new Promise((resolve) => {
    const signalPath = join(process.cwd(), "github-oauth-probe-release-" + turnNum);
    const check = () => {
      if (existsSync(signalPath)) resolve();
      else setTimeout(check, 25);
    };
    check();
  });

const extractPromptText = (params) => {
  if (!params || !Array.isArray(params.prompt)) return "";
  return params.prompt
    .map((block) => (block && typeof block.text === "string" ? block.text : ""))
    .join("\\n");
};

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
        agentInfo: { name: "GitHub OAuth Probe", version: "1.0.0" },
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
    const promptText = extractPromptText(params);
    const shouldHold = promptText.includes("HOLD_TURN");

    const filePath = join(process.cwd(), "oauth-turn-" + turnNum + ".txt");
    writeFileSync(filePath, "oauth turn " + turnNum + "\\n", "utf8");

    const addRes = spawnSync("git", ["add", filePath], { cwd: process.cwd(), encoding: "utf8" });
    const commitRes = spawnSync(
      "git",
      ["commit", "-m", "OAuth commit turn " + turnNum],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const pushRes = spawnSync(
      "git",
      ["push", "origin", "HEAD:refs/heads/oauth-turn-" + turnNum],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const ghTokenRes = spawnSync("gh", ["auth", "token"], { cwd: process.cwd(), encoding: "utf8" });
    const ghPrRes = spawnSync(
      "gh",
      ["api", "-X", "POST", "/repos/org/repo/pulls", "-f", "title=OAuth PR turn " + turnNum],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    const serializedEnv = JSON.stringify(process.env);
    appendFileSync(
      logPath,
      JSON.stringify({
        turnNum,
        pid: process.pid,
        promptText,
        hasRefreshTokenInEnv: serializedEnv.includes("ghr_e2e_"),
        hasClientSecretInEnv: serializedEnv.includes("E2E_OAUTH_CLIENT_SECRET"),
        gitAuthorName: process.env.GIT_AUTHOR_NAME ?? null,
        gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL ?? null,
        gitAskpass: process.env.GIT_ASKPASS ?? null,
        brokerEndpoint: process.env.T3_TEAM_GH_BROKER_ENDPOINT ?? null,
        brokerToken: process.env.T3_TEAM_GH_BROKER_TOKEN ?? null,
        t3ThreadId: process.env.T3CODE_THREAD_ID ?? null,
        pathEnv: process.env.PATH ?? "",
        addStatus: addRes.status,
        commitStatus: commitRes.status,
        pushStatus: pushRes.status,
        pushStderr: pushRes.stderr,
        ghTokenStatus: ghTokenRes.status,
        ghTokenStdout: ghTokenRes.stdout.trim(),
        ghPrStatus: ghPrRes.status,
      }) + "\\n",
      "utf8",
    );

    if (shouldHold) {
      await waitForRelease(turnNum);
    }

    send({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "GITHUB_OAUTH_PROBE_OK turn=" + turnNum },
        },
      },
    });
    send({ id, result: { stopReason: "end_turn" } });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

interface OAuthProbeRecord {
  readonly turnNum: number;
  readonly pid: number;
  readonly promptText: string;
  readonly hasRefreshTokenInEnv: boolean;
  readonly hasClientSecretInEnv: boolean;
  readonly gitAuthorName: string | null;
  readonly gitAuthorEmail: string | null;
  readonly gitAskpass: string | null;
  readonly brokerEndpoint: string | null;
  readonly brokerToken: string | null;
  readonly t3ThreadId: string | null;
  readonly pathEnv: string;
  readonly addStatus: number | null;
  readonly commitStatus: number | null;
  readonly pushStatus: number | null;
  readonly pushStderr: string;
  readonly ghTokenStatus: number | null;
  readonly ghTokenStdout: string;
  readonly ghPrStatus: number | null;
}

function readProbeRecords(logPath: string): ReadonlyArray<OAuthProbeRecord> {
  if (!NodeFS.existsSync(logPath)) return [];
  return NodeFS.readFileSync(logPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as OAuthProbeRecord);
}

function queryCapturedGhToken(record: OAuthProbeRecord) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: record.pathEnv,
    T3_TEAM_GH_BROKER_ENDPOINT: record.brokerEndpoint ?? "",
    T3_TEAM_GH_BROKER_TOKEN: record.brokerToken ?? "",
  };
  if (record.t3ThreadId !== null) {
    env.T3CODE_THREAD_ID = record.t3ThreadId;
  } else {
    delete env.T3CODE_THREAD_ID;
  }
  return NodeChildProcess.spawnSync("gh", ["auth", "token"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

async function createInviteAndJoin(input: {
  readonly inviter: TeamMemberHandle;
  readonly invitee: TeamMemberHandle;
  readonly roleLabel: string;
  readonly pseudo: string;
}) {
  const { inviter, invitee, roleLabel, pseudo } = input;
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
  const webJoinLink = await inviter.page.getByTestId("team-invite-weblink").inputValue();
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

async function completeBrowserOAuthFromSettings(input: {
  readonly settingsPage: TeamMemberHandle["page"];
  readonly context: TeamMemberHandle["context"];
  readonly expectedLogin: string;
  readonly expectUnconnectedBeforeConfirm?: boolean;
}) {
  const { settingsPage, context, expectedLogin, expectUnconnectedBeforeConfirm = false } = input;
  const popupPromise = context.waitForEvent("page");
  await settingsPage.getByTestId("team-my-github-oauth-signin").click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded", { timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const text =
          (await popup
            .locator("body")
            .textContent()
            .catch(() => "")) ?? "";
        return (
          text.includes(`Connected as @${expectedLogin}`) || text.includes("Confirmation required")
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  const codeLocator = popup.getByTestId("github-oauth-confirmation-code");
  if ((await codeLocator.count()) > 0) {
    const confirmationCode = ((await codeLocator.textContent()) ?? "").trim();
    expect(confirmationCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    if (expectUnconnectedBeforeConfirm) {
      expect(
        (await settingsPage
          .getByTestId("team-my-github-status")
          .textContent()
          .catch(() => "")) ?? "",
      ).toContain("Not connected");
    }
    await popup.close();
    await settingsPage
      .getByTestId("team-my-github-oauth-confirm-input")
      .waitFor({ state: "visible", timeout: 10_000 });
    await settingsPage.getByTestId("team-my-github-oauth-confirm-input").fill(confirmationCode);
    await settingsPage.getByTestId("team-my-github-oauth-confirm-submit").click();
    return;
  }
  await popup.close();
}

test("Milestone 7 Phase 7b: GitHub App OAuth + PKCE, RFC 8628 device flow, automatic short-lived token refresh rotation, needsReconnect fail-closed, and disconnect lease revocation", async ({
  app,
}) => {
  await using topology = await startTeamTopology({
    viteUrl: app.baseUrl ?? "",
    members: [
      { pseudo: "alice", role: "owner" },
      { pseudo: "bob", role: "regular" },
    ],
    fakeGitHub: true,
  });

  const fakeGitHub = topology.fakeGitHub!;
  const alice = topology.member("alice");
  const bob = topology.member("bob");

  const projectDir = await topology.teamServer.project(
    "team-github-oauth-repo",
    { "README.md": "# Team GitHub M7b\n" },
    { gitOriginUrl: fakeGitHub.repoUrl },
  );
  const probeScriptPath = NodePath.join(topology.teamServer.home, "github-oauth-probe-acp.mjs");
  NodeFS.writeFileSync(probeScriptPath, GITHUB_OAUTH_PROBE_ACP, "utf8");
  const probeLogPath = NodePath.join(projectDir, "github-oauth-probe-turns.jsonl");
  const probeInstanceId = ProviderInstanceId.make("github-oauth-probe");

  await runPromise(
    Effect.gen(function* () {
      const client = yield* rpcClient(topology.teamServer.home, topology.teamServer.origin);
      yield* client["server.updateSettings"]({
        patch: {
          defaultModelSelection: { instanceId: probeInstanceId, model: "default" },
        },
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: probeInstanceId,
          instance: {
            driver: ProviderDriverKind.make("acpRegistry"),
            displayName: "GitHub OAuth Probe",
            enabled: true,
            config: {
              source: "local",
              commandPath: process.execPath,
              commandArgs: [probeScriptPath],
            },
          },
        },
      });
    }).pipe(Effect.scoped),
  );

  // 1. Alice pairs with Team Server, initializes team, and invites Bob.
  await alice.pairWithRemoteServer({
    host: topology.teamServer.origin,
    pairingToken: topology.teamServer.pairingToken,
  });
  await alice.open("/settings/teams");
  await alice.page.getByTestId("team-server-select").click();
  await alice.page.getByRole("option", { name: /Team Server/ }).click();
  await alice.page.getByTestId("team-init-name").fill("Acme OAuth M7b");
  await alice.page.getByTestId("team-init-pseudo").fill("alice");
  await alice.page.getByTestId("team-init-submit").click();
  await alice.page
    .getByTestId("teams-settings-tabs")
    .waitFor({ state: "visible", timeout: 20_000 });

  await createInviteAndJoin({
    inviter: alice,
    invitee: bob,
    roleLabel: "Regular",
    pseudo: "bob",
  });

  // 2. Owner (Alice) configures Team GitHub App OAuth pointing at Fake GitHub.
  await selectTeamSettingsTab(alice.page, "providers");
  await alice.page.getByTestId("team-github-app-client-id-input").fill("Iv1.e2eacme");
  await alice.page
    .getByTestId("team-github-app-client-secret-input")
    .fill("E2E_OAUTH_CLIENT_SECRET");
  await alice.page.getByTestId("team-github-app-advanced-toggle").click();
  await alice.page.getByTestId("team-github-app-web-url-input").fill(fakeGitHub.origin);
  await alice.page.getByTestId("team-github-app-api-url-input").fill(fakeGitHub.origin);
  await alice.page.getByTestId("team-github-app-save").click();

  await expect
    .poll(
      async () =>
        (await alice.page
          .getByTestId("team-github-app-status")
          .textContent()
          .catch(() => "")) ?? "",
      { timeout: 15_000 },
    )
    .toContain("Enabled");

  // Configure Fake GitHub to issue a near-expiry token (60s < 5 min safety margin) on initial OAuth sign-in
  // so Alice's very first turn MUST proactively refresh server-side & rotate refresh_token!
  fakeGitHub.oauth.setNextAuthorizeUser({
    id: 401,
    login: "alice-oauth",
    name: "Alice OAuth",
    email: "alice-oauth@test.example",
  });
  fakeGitHub.oauth.setNextTokenExpiresIn(60);

  // 3. Alice clicks "Sign in with GitHub" -> popup hits Fake GitHub -> redirects to Team Server callback -> confirms & connects!
  await completeBrowserOAuthFromSettings({
    settingsPage: alice.page,
    context: alice.context,
    expectedLogin: "alice-oauth",
    expectUnconnectedBeforeConfirm: true,
  });

  await expect
    .poll(
      async () =>
        (await alice.page
          .getByTestId("team-my-github-login")
          .textContent()
          .catch(() => "")) ?? "",
      { timeout: 15_000 },
    )
    .toContain("@alice-oauth");
  await expect
    .poll(
      async () =>
        (await alice.page
          .getByTestId("team-my-github-method-badge")
          .textContent()
          .catch(() => "")) ?? "",
      { timeout: 10_000 },
    )
    .toContain("GitHub App");
  await alice.page
    .getByTestId("team-my-github-autorefresh-badge")
    .waitFor({ state: "visible", timeout: 10_000 });

  const initialAccessToken = fakeGitHub.oauth.mintedAccessTokens()[0]!;
  expect(initialAccessToken).toContain("ghu_e2e_alice-oauth_");
  expect(fakeGitHub.oauth.refreshHits()).toBe(0);

  // 4. Bob (regular) opens Settings -> does NOT see admin OAuth config form, signs in via RFC 8628 Device Flow!
  await bob.open("/settings/teams");
  await selectTeamSettingsTab(bob.page, "providers");
  await bob.page
    .getByTestId("team-my-github-device-signin")
    .waitFor({ state: "visible", timeout: 20_000 });
  expect(await bob.page.getByTestId("team-github-app-form").count()).toBe(0);

  fakeGitHub.oauth.setNextTokenExpiresIn(28_800);
  await bob.page.getByTestId("team-my-github-device-signin").click();
  await bob.page
    .getByTestId("team-my-github-device-code")
    .waitFor({ state: "visible", timeout: 15_000 });
  const bobUserCode = (await bob.page
    .getByTestId("team-my-github-device-code")
    .textContent())!.trim();
  expect(bobUserCode).toMatch(/^TEAM-\d{4}$/);

  fakeGitHub.oauth.approveDeviceCode(bobUserCode, {
    id: 502,
    login: "bob-device",
    name: "Bob Device",
    email: "bob-device@test.example",
  });

  await expect
    .poll(
      async () =>
        (await bob.page
          .getByTestId("team-my-github-login")
          .textContent()
          .catch(() => "")) ?? "",
      { timeout: 20_000 },
    )
    .toContain("@bob-device");

  // 5. Alice runs Turn 1: her 60s token triggers automatic server-side refresh (rotating refresh_token)
  //    to a long-lived 8h token, and her turn commits, pushes, and opens a PR under that EXACT rotated token!
  fakeGitHub.oauth.setNextTokenExpiresIn(28_800);
  await alice.open("/");
  await alice.page.getByRole("button", { name: "New thread" }).first().click();
  const aliceComposer = alice.page.locator('[contenteditable="true"]').first();
  await aliceComposer.waitFor({ state: "visible", timeout: 15_000 });
  await aliceComposer.click();
  await aliceComposer.fill("Alice OAuth Refresh Turn 1");
  await aliceComposer.press("Enter");

  await expect
    .poll(() => readProbeRecords(probeLogPath).length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(async () => await alice.page.getByRole("button", { name: "Stop generation" }).count(), {
      timeout: 20_000,
    })
    .toBe(0);

  const turn1 = readProbeRecords(probeLogPath)[0]!;
  expect(fakeGitHub.oauth.refreshHits()).toBe(1);
  expect(turn1.hasRefreshTokenInEnv).toBe(false);
  expect(turn1.hasClientSecretInEnv).toBe(false);
  expect(turn1.gitAuthorName).toBe("Alice OAuth");
  expect(turn1.gitAuthorEmail).toBe("alice-oauth@test.example");
  expect(turn1.commitStatus).toBe(0);
  expect(turn1.pushStatus, turn1.pushStderr).toBe(0);
  expect(turn1.ghTokenStatus).toBe(0);
  expect(turn1.ghPrStatus).toBe(0);
  // Used the single rotated fresh access token across git push, gh auth token, and gh pr create!
  expect(turn1.ghTokenStdout).not.toBe(initialAccessToken);
  expect(turn1.ghTokenStdout).toContain("ghu_e2e_alice-oauth_");
  expect(fakeGitHub.gitRequests().some((r) => r.token === turn1.ghTokenStdout)).toBe(true);
  expect(fakeGitHub.createdPullRequests()[0]).toMatchObject({
    title: "OAuth PR turn 1",
    authorLogin: "alice-oauth",
    token: turn1.ghTokenStdout,
  });

  // 6. Issue a near-expiry (60s) OAuth token for Alice via the real UI flow, revoke her GitHub App
  //    refresh token, then run Turn 2 -> must fail closed with zero credentials (never uses Bob's token!)
  //    and Alice's Settings UI displays Reconnect required!
  fakeGitHub.oauth.setNextTokenExpiresIn(60);
  const reauthTab = await alice.context.newPage();
  await reauthTab.goto(`${alice.origin}/settings/teams`, { waitUntil: "domcontentloaded" });
  await selectTeamSettingsTab(reauthTab, "providers");
  await reauthTab
    .getByTestId("team-my-github-oauth-signin")
    .waitFor({ state: "visible", timeout: 15_000 });
  await completeBrowserOAuthFromSettings({
    settingsPage: reauthTab,
    context: alice.context,
    expectedLogin: "alice-oauth",
  });
  await expect
    .poll(() => fakeGitHub.oauth.mintedAccessTokens().length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(4);
  await reauthTab.close();

  fakeGitHub.oauth.setRefreshRevoked(true);
  await aliceComposer.click();
  await aliceComposer.fill("Alice Revoked Refresh Turn 2");
  await aliceComposer.press("Enter");

  await expect
    .poll(() => readProbeRecords(probeLogPath).length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(async () => await alice.page.getByRole("button", { name: "Stop generation" }).count(), {
      timeout: 20_000,
    })
    .toBe(0);

  const turn2 = readProbeRecords(probeLogPath)[1]!;
  expect(turn2.pushStatus).not.toBe(0);
  expect(turn2.ghTokenStatus).not.toBe(0);
  expect(turn2.ghPrStatus).not.toBe(0);

  await alice.open("/settings/teams");
  await selectTeamSettingsTab(alice.page, "providers");
  await expect
    .poll(
      async () =>
        (await alice.page
          .getByTestId("team-my-github-status")
          .textContent()
          .catch(() => "")) ?? "",
      { timeout: 15_000 },
    )
    .toContain("Reconnect required");
  await alice.page
    .getByTestId("team-my-github-reconnect-banner")
    .waitFor({ state: "visible", timeout: 10_000 });

  // 7. Reconnect Alice via OAuth, start a HOLD_TURN, then Disconnect -> active turn lease revoked immediately!
  fakeGitHub.oauth.setRefreshRevoked(false);
  fakeGitHub.oauth.setNextTokenExpiresIn(28_800);
  await completeBrowserOAuthFromSettings({
    settingsPage: alice.page,
    context: alice.context,
    expectedLogin: "alice-oauth",
  });

  await expect
    .poll(
      async () =>
        (await alice.page
          .getByTestId("team-my-github-status")
          .textContent()
          .catch(() => "")) ?? "",
      { timeout: 15_000 },
    )
    .toContain("Connected");

  await alice.open("/");
  await alice.page.getByRole("button", { name: "New thread" }).first().click();
  await aliceComposer.waitFor({ state: "visible", timeout: 15_000 });
  await aliceComposer.click();
  await aliceComposer.fill("Alice Disconnect HOLD_TURN 3");
  await aliceComposer.press("Enter");

  await expect
    .poll(() => readProbeRecords(probeLogPath).length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(3);
  const turn3 = readProbeRecords(probeLogPath)[2]!;
  expect(queryCapturedGhToken(turn3).status).toBe(0);

  // Open a second tab in Alice's browser to disconnect while Turn 3 is still actively held.
  const settingsTab = await alice.context.newPage();
  await settingsTab.goto(`${alice.origin}/settings/teams`, { waitUntil: "domcontentloaded" });
  await selectTeamSettingsTab(settingsTab, "providers");
  await settingsTab
    .getByTestId("team-my-github-disconnect")
    .waitFor({ state: "visible", timeout: 20_000 });
  await settingsTab.getByTestId("team-my-github-disconnect").click();
  await confirmDestructiveActionDialog(settingsTab);

  await expect
    .poll(
      async () =>
        (await settingsTab
          .getByTestId("team-my-github-status")
          .textContent()
          .catch(() => "")) ?? "",
      { timeout: 15_000 },
    )
    .toContain("Not connected");

  // Active Turn 3's broker lease is IMMEDIATELY revoked!
  await expect.poll(() => queryCapturedGhToken(turn3).status, { timeout: 15_000 }).not.toBe(0);
  await settingsTab.close();

  NodeFS.writeFileSync(
    NodePath.join(projectDir, `github-oauth-probe-release-${turn3.turnNum}`),
    "ok",
    "utf8",
  );
  await expect
    .poll(async () => await alice.page.getByRole("button", { name: "Stop generation" }).count(), {
      timeout: 20_000,
    })
    .toBe(0);

  // Sanity check bare repo received Turn 1 commit authored by Alice OAuth.
  const turn1Log = NodeChildProcess.spawnSync(
    "git",
    [
      "--git-dir",
      fakeGitHub.bareRepoPath,
      "log",
      "-1",
      "--format=%an|%ae|%s",
      "refs/heads/oauth-turn-1",
    ],
    { encoding: "utf8" },
  );
  expect(turn1Log.status).toBe(0);
  expect(turn1Log.stdout.trim()).toBe("Alice OAuth|alice-oauth@test.example|OAuth commit turn 1");
});
