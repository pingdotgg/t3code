// @effect-diagnostics nodeBuiltinImport:off -- The scenario registers a local ACP probe and inspects bare repo commits.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { rpcClient, runPromise } from "../t3.ts";
import { startTeamTopology, type TeamMemberHandle } from "./topology.ts";
import { openTeamInviteForm, selectTeamSettingsTab } from "./ui-helpers.ts";

// Dual-purpose ACP probe for Milestone 8: logs PID, injected T3 MCP credentials, and
// GitHub broker state on every turn, optionally commits+pushes to Fake GitHub when prompted
// with DO_GIT_PUSH, and optionally holds the turn open until a release file appears (HOLD_TURN).
const AUTOMATION_PROBE_ACP = `
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const logPath = join(process.cwd(), "automation-probe-turns.jsonl");
let sessionId = "auto-probe-session-" + process.pid;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");

const waitForRelease = (tag) =>
  new Promise((resolve) => {
    const signalPath = join(process.cwd(), "automation-probe-release-" + tag);
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
        agentInfo: { name: "Automation Probe", version: "1.0.0" },
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
    const holdMatch = promptText.match(/HOLD_TURN:([a-zA-Z0-9_-]+)/);
    const doGitPush = promptText.includes("DO_GIT_PUSH");

    let commitStatus = null;
    let pushStatus = null;
    let pushStderr = "";
    let ghTokenStatus = null;
    if (doGitPush) {
      const filePath = join(process.cwd(), "auto-turn-" + turnNum + ".txt");
      writeFileSync(filePath, "turn " + turnNum + " pid=" + process.pid + "\\n", "utf8");
      spawnSync("git", ["add", filePath], { cwd: process.cwd(), encoding: "utf8" });
      const commitRes = spawnSync(
        "git",
        ["commit", "-m", "Automation commit turn " + turnNum],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      commitStatus = commitRes.status;
      const pushRes = spawnSync(
        "git",
        ["push", "origin", "HEAD:refs/heads/auto-turn-" + turnNum],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      pushStatus = pushRes.status;
      pushStderr = pushRes.stderr ?? "";
      const ghRes = spawnSync("gh", ["auth", "token"], { cwd: process.cwd(), encoding: "utf8" });
      ghTokenStatus = ghRes.status;
    }

    appendFileSync(
      logPath,
      JSON.stringify({
        turnNum,
        pid: process.pid,
        promptText,
        mcpEndpoint: process.env.T3_ACP_MCP_ENDPOINT ?? null,
        mcpAuthorization: process.env.T3_ACP_MCP_AUTHORIZATION ?? null,
        hasStaticGhToken: Object.prototype.hasOwnProperty.call(process.env, "GH_TOKEN"),
        hasStaticGitHubToken: Object.prototype.hasOwnProperty.call(process.env, "GITHUB_TOKEN"),
        gitAuthorName: process.env.GIT_AUTHOR_NAME ?? null,
        gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL ?? null,
        gitAskpass: process.env.GIT_ASKPASS ?? null,
        brokerEndpoint: process.env.T3_TEAM_GH_BROKER_ENDPOINT ?? null,
        brokerToken: process.env.T3_TEAM_GH_BROKER_TOKEN ?? null,
        t3ThreadId: process.env.T3CODE_THREAD_ID ?? null,
        commitStatus,
        pushStatus,
        pushStderr,
        ghTokenStatus,
      }) + "\\n",
      "utf8",
    );

    if (holdMatch) {
      await waitForRelease(holdMatch[1]);
    }

    send({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "AUTO_PROBE_OK turn=" + turnNum + " pid=" + process.pid },
        },
      },
    });
    send({ id, result: { stopReason: "end_turn" } });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

interface AutomationProbeRecord {
  readonly turnNum: number;
  readonly pid: number;
  readonly promptText: string;
  readonly mcpEndpoint: string | null;
  readonly mcpAuthorization: string | null;
  readonly hasStaticGhToken: boolean;
  readonly hasStaticGitHubToken: boolean;
  readonly gitAuthorName: string | null;
  readonly gitAuthorEmail: string | null;
  readonly gitAskpass: string | null;
  readonly brokerEndpoint: string | null;
  readonly brokerToken: string | null;
  readonly t3ThreadId: string | null;
  readonly commitStatus: number | null;
  readonly pushStatus: number | null;
  readonly pushStderr: string;
  readonly ghTokenStatus: number | null;
}

function readProbeRecords(logPath: string): ReadonlyArray<AutomationProbeRecord> {
  if (!NodeFS.existsSync(logPath)) return [];
  return NodeFS.readFileSync(logPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AutomationProbeRecord);
}

function queryCapturedAskpass(record: AutomationProbeRecord, expectedOrigin: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    T3_TEAM_GH_BROKER_ENDPOINT: record.brokerEndpoint ?? "",
    T3_TEAM_GH_BROKER_TOKEN: record.brokerToken ?? "",
  };
  if (record.t3ThreadId !== null) {
    env.T3CODE_THREAD_ID = record.t3ThreadId;
  } else {
    delete env.T3CODE_THREAD_ID;
  }
  return NodeChildProcess.spawnSync(record.gitAskpass!, [`Password for '${expectedOrigin}':`], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

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
        clientInfo: { name: "team-m8-e2e", version: "1.0.0" },
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

test("Milestone 8: (team, env) scheduled-task RBAC, team-owned threads, synthetic team-automation MCP containment, and GitHub automation integration", async ({
  app,
}) => {
  await using topology = await startTeamTopology({
    viteUrl: app.baseUrl ?? "",
    members: [
      { pseudo: "alice", role: "owner" },
      { pseudo: "charlie", role: "modo" },
      { pseudo: "bob", role: "regular" },
    ],
    fakeGitHub: true,
  });

  const fakeGitHub = topology.fakeGitHub!;
  const alice = topology.member("alice");
  const charlie = topology.member("charlie");
  const bob = topology.member("bob");

  const projectDir = await topology.teamServer.project(
    "team-auto-repo",
    { "README.md": "# Team Automations M8\n" },
    { gitOriginUrl: fakeGitHub.repoUrl },
  );
  const probeScriptPath = NodePath.join(topology.teamServer.home, "automation-probe-acp.mjs");
  NodeFS.writeFileSync(probeScriptPath, AUTOMATION_PROBE_ACP, "utf8");
  const probeLogPath = NodePath.join(projectDir, "automation-probe-turns.jsonl");
  const probeInstanceId = ProviderInstanceId.make("auto-probe");

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
            displayName: "Automation Probe",
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

  // 1. Alice initializes the team.
  await alice.pairWithRemoteServer({
    host: topology.teamServer.origin,
    pairingToken: topology.teamServer.pairingToken,
  });
  await alice.open("/settings/teams");
  await alice.page.getByTestId("team-server-select").click();
  await alice.page.getByRole("option", { name: /Team Server/ }).click();
  await alice.page.getByTestId("team-init-name").fill("Automation Corp");
  await alice.page.getByTestId("team-init-pseudo").fill("alice");
  await alice.page.getByTestId("team-init-submit").click();
  // Invite Charlie (modo) and Bob (regular).
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

  // 2. Alice connects her personal GitHub PAT (leaving Team Automation GitHub UNCONFIGURED)
  //    and creates an admin-only View + secret thread to test minimal vs elevated MCP containment.
  await selectTeamSettingsTab(alice.page, "providers");
  await alice.page.getByTestId("team-my-github-advanced-toggle").click();
  await alice.page.getByTestId("team-my-github-api-url-input").fill(fakeGitHub.origin);
  await alice.page.getByTestId("team-my-github-token-input").fill(fakeGitHub.tokens.alice);
  await alice.page.getByTestId("team-my-github-save").click();
  await expect
    .poll(
      async () =>
        (await alice.page
          .getByTestId("team-my-github-login")
          .textContent()
          .catch(() => "")) ?? "",
      { timeout: 15_000 },
    )
    .toContain("@alice-gh");

  await selectTeamSettingsTab(alice.page, "access");
  await alice.page.getByTestId("team-view-create-open").click();
  await alice.page.getByTestId("team-view-name-input").fill("Admin Secret");
  await alice.page.getByTestId("team-view-read-role-modo").click();
  await alice.page.getByTestId("team-view-read-role-regular").click();
  await alice.page.getByTestId("team-view-save").click();
  await alice.page
    .getByTestId("team-view-row-Admin Secret")
    .waitFor({ state: "visible", timeout: 15_000 });

  // Alice starts a thread on Team Server and moves it into "Admin Secret" view.
  await alice.open("/");
  await alice.page.getByRole("button", { name: "New thread" }).first().click();
  const aliceComposer = alice.page.locator('[contenteditable="true"]').first();
  await aliceComposer.waitFor({ state: "visible", timeout: 15_000 });
  await aliceComposer.click();
  await aliceComposer.fill("Secret executive plan");
  await aliceComposer.press("Enter");
  await expect
    .poll(() => readProbeRecords(probeLogPath).length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(async () => await alice.page.getByRole("button", { name: "Stop generation" }).count(), {
      timeout: 20_000,
    })
    .toBe(0);
  const adminSecretThreadId = readProbeRecords(probeLogPath)[0]!.t3ThreadId!;
  expect(adminSecretThreadId).toBeTruthy();

  // Move Alice's secret thread into "Admin Secret" view via thread header View selector.
  await alice.page
    .getByTestId("team-thread-view-pill")
    .waitFor({ state: "visible", timeout: 15_000 });
  await alice.page.getByTestId("team-thread-view-pill").click();
  await alice.page.getByTestId("team-thread-view-option-Admin Secret").click();
  await expect
    .poll(async () => (await alice.page.getByTestId("team-thread-view-pill").textContent()) ?? "", {
      timeout: 10_000,
    })
    .toContain("Admin Secret");

  // 3. Personal env hides virtual "personal" team in Scheduled Tasks UI.
  await charlie.open("/settings/scheduled-tasks");
  const scopeFilter = charlie.page.getByTestId("scheduled-tasks-team-env-filter");
  await scopeFilter.waitFor({ state: "visible", timeout: 20_000 });
  await scopeFilter.click();
  await charlie.page
    .getByRole("option", { name: /Automation Corp/ })
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  const optionTexts = await charlie.page.getByRole("option").allTextContents();
  expect(optionTexts.some((text) => text.includes("Automation Corp"))).toBe(true);
  expect(optionTexts.some((text) => /personal/i.test(text))).toBe(false);
  await charlie.page.keyboard.press("Escape");

  // 4. Charlie (modo) creates a minimal team scheduled task on (team, env) ->
  //    verifies modo sees Target view, does NOT see locked or elevated MCP controls.
  await charlie.page.getByRole("button", { name: "New task" }).click();
  const dialog = charlie.page.getByRole("dialog", { name: "New task" });
  await dialog.waitFor({ state: "visible", timeout: 15_000 });
  // Ensure Team Server is selected in "Runs on".
  await dialog.locator("#scheduled-task-environment").click();
  await charlie.page.getByRole("option", { name: /Automation Corp/ }).click();

  await dialog
    .getByTestId("scheduled-task-team-view")
    .waitFor({ state: "visible", timeout: 10_000 });
  expect(await dialog.getByTestId("scheduled-task-team-locked").count()).toBe(0);
  expect(await dialog.getByTestId("scheduled-task-team-mcp-access").count()).toBe(0);

  await dialog.locator("#scheduled-task-title").fill("Daily Triage");
  await dialog.locator("#scheduled-task-workspace").click();
  await charlie.page.getByRole("option", { name: "Use the project checkout" }).click();
  await dialog.locator("#scheduled-task-prompt").fill("Run daily triage DO_GIT_PUSH");
  await dialog.getByRole("button", { name: "Create task" }).click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });
  await charlie.page
    .getByRole("heading", { name: "Daily Triage" })
    .waitFor({ state: "visible", timeout: 15_000 });

  // 5. Regular Bob sees "Daily Triage" in Read-only mode (cannot toggle, run, or delete).
  await bob.open("/settings/scheduled-tasks");
  await bob.page
    .getByRole("heading", { name: "Daily Triage" })
    .waitFor({ state: "visible", timeout: 20_000 });
  await bob.page
    .getByTestId("scheduled-task-team-readonly-badge")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  expect(await bob.page.getByRole("switch", { name: "Enable Daily Triage" }).isDisabled()).toBe(
    true,
  );
  await bob.page.getByRole("button", { name: "Actions for Daily Triage" }).click();
  await bob.page
    .getByRole("menuitem", { name: "View" })
    .waitFor({ state: "visible", timeout: 10_000 });
  expect(await bob.page.getByRole("menuitem", { name: "Run now" }).count()).toBe(0);
  expect(await bob.page.getByRole("menuitem", { name: "Delete" }).count()).toBe(0);
  await bob.page.keyboard.press("Escape");

  // 6. Prepare notification watchers (unfocused windows) before Charlie runs "Daily Triage"
  //    with NO Team Automation GitHub account configured -> runs cleanly with zero GitHub creds,
  //    creates team-owned thread "scheduled: Daily Triage", hidden by default, zero notifications!
  await alice.open("/");
  await bob.open("/");
  await alice.setWindowFocused(false);
  await bob.setWindowFocused(false);
  await alice.clearNotifications();
  await bob.clearNotifications();
  fakeGitHub.reset();

  const recordsBeforeRun1 = readProbeRecords(probeLogPath).length;
  await charlie.page.getByRole("button", { name: "Actions for Daily Triage" }).click();
  await charlie.page.getByRole("menuitem", { name: "Run now" }).click();

  await expect
    .poll(() => readProbeRecords(probeLogPath).length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(recordsBeforeRun1 + 1);
  const minAutoRecord = readProbeRecords(probeLogPath)[recordsBeforeRun1]!;
  // Zero GitHub credentials injected when Team Automation GitHub is unconfigured (fail-closed broker, never borrows Alice's PAT!).
  expect(minAutoRecord.hasStaticGhToken).toBe(false);
  expect(minAutoRecord.hasStaticGitHubToken).toBe(false);
  expect(minAutoRecord.gitAuthorName).toBeNull();
  expect(minAutoRecord.ghTokenStatus).not.toBe(0);
  expect(minAutoRecord.pushStatus).not.toBe(0);
  expect(fakeGitHub.gitRequests()).toHaveLength(0);

  // Verify minimal team-automation MCP principal CANNOT read Admin Secret thread or manage schedules!
  expect(minAutoRecord.mcpEndpoint).toBeTruthy();
  expect(minAutoRecord.mcpAuthorization).toBeTruthy();
  const minReadAdmin = await callMcpTool({
    request: charlie.page.request,
    endpoint: minAutoRecord.mcpEndpoint!,
    authorization: minAutoRecord.mcpAuthorization!,
    toolName: "t3_thread_read",
    args: { threadId: adminSecretThreadId },
  });
  expect(minReadAdmin.isError).toBe(true);
  const minListThreads = await callMcpTool({
    request: charlie.page.request,
    endpoint: minAutoRecord.mcpEndpoint!,
    authorization: minAutoRecord.mcpAuthorization!,
    toolName: "t3_thread_list",
    args: {},
  });
  expect(minListThreads.isError).toBe(false);
  expect(minListThreads.text).not.toContain(adminSecretThreadId);

  // Team-owned thread is hidden by default in Bob's sidebar & produces zero notifications.
  await bob.setWindowFocused(true);
  await alice.setWindowFocused(true);
  expect(await bob.notifications()).toEqual([]);
  expect(await alice.notifications()).toEqual([]);
  expect(await bob.page.getByText("scheduled: Daily Triage").count()).toBe(0);

  // Toggling colleagues/all-team-threads reveals "scheduled: Daily Triage".
  await bob.page.getByTestId("team-colleagues-toggle").click();
  await bob.page.getByText("scheduled: Daily Triage").first().waitFor({
    state: "visible",
    timeout: 15_000,
  });

  // 7. Alice configures the dedicated Team Automation GitHub account (@acme-bot) in Settings -> Teams.
  await alice.open("/settings/teams");
  await selectTeamSettingsTab(alice.page, "providers");
  await alice.page.getByTestId("team-automation-github-advanced-toggle").click();
  await alice.page.getByTestId("team-automation-github-api-url-input").fill(fakeGitHub.origin);
  await alice.page
    .getByTestId("team-automation-github-token-input")
    .fill(fakeGitHub.tokens.automation);
  await alice.page.getByTestId("team-automation-github-save").click();
  await expect
    .poll(
      async () =>
        (await alice.page
          .getByTestId("team-automation-github-login")
          .textContent()
          .catch(() => "")) ?? "",
      { timeout: 15_000 },
    )
    .toContain("@acme-bot");

  // 8. Charlie edits "Daily Triage" to hold open + git push, runs it ->
  //    proves dedicated Team Automation GitHub PAT (never human PAT), mid-turn dashed queue for modo
  //    with NO Send now and NO Interrupt, and warm-session recycle when Charlie's follow-up turn runs!
  fakeGitHub.reset();
  await charlie.page.getByRole("button", { name: "Actions for Daily Triage" }).click();
  await charlie.page.getByRole("menuitem", { name: "Edit" }).click();
  const editDialog = charlie.page.getByRole("dialog", { name: "Edit task" });
  await editDialog.waitFor({ state: "visible", timeout: 15_000 });
  await editDialog.locator("#scheduled-task-prompt").fill("Run triage HOLD_TURN:t2 DO_GIT_PUSH");
  await editDialog.getByRole("button", { name: "Save task" }).click();
  await editDialog.waitFor({ state: "hidden", timeout: 15_000 });

  const recordsBeforeRun2 = readProbeRecords(probeLogPath).length;
  await charlie.page.getByRole("button", { name: "Actions for Daily Triage" }).click();
  await charlie.page.getByRole("menuitem", { name: "Run now" }).click();
  await expect
    .poll(() => readProbeRecords(probeLogPath).length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(recordsBeforeRun2 + 1);
  const autoBotRecord = readProbeRecords(probeLogPath)[recordsBeforeRun2]!;
  expect(autoBotRecord.gitAuthorName).toBe("Acme Automation");
  expect(autoBotRecord.gitAuthorEmail).toBe("bot@test.example");
  expect(autoBotRecord.commitStatus).toBe(0);
  expect(autoBotRecord.pushStatus, autoBotRecord.pushStderr).toBe(0);
  expect(fakeGitHub.gitRequests().some((r) => r.token === fakeGitHub.tokens.automation)).toBe(true);
  expect(fakeGitHub.gitRequests().some((r) => r.token === fakeGitHub.tokens.alice)).toBe(false);

  // Charlie opens the EXACT active team-owned thread while automation turn is running and queues a follow-up.
  expect(autoBotRecord.t3ThreadId).toBeTruthy();
  await charlie.open(`/${topology.teamServer.environmentId}/${autoBotRecord.t3ThreadId!}`);
  const charlieComposer = charlie.page.locator('[contenteditable="true"]').first();
  await charlieComposer.waitFor({ state: "visible", timeout: 15_000 });
  // Wait for the active automation run's folded message bubble to hydrate so phase === "running".
  await charlie.page
    .locator("[data-user-message-bubble]")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  // Modo sees explicit Interrupt on an UNLOCKED active automation run (never Send now).
  const charlieAutoInterruptBtn = charlie.page.getByTestId("team-admin-interrupt-button");
  await charlieAutoInterruptBtn.waitFor({ state: "visible", timeout: 15_000 });
  expect((await charlieAutoInterruptBtn.textContent()) ?? "").toContain("Interrupt");
  await charlieComposer.click();
  await charlieComposer.fill("Charlie follow-up after automation");
  await charlieComposer.press("Enter");
  const queueSection = charlie.page.locator('[data-thread-queue="true"]');
  await queueSection.waitFor({ state: "visible", timeout: 15_000 });
  await expect
    .poll(async () => (await queueSection.textContent()) ?? "", { timeout: 10_000 })
    .toContain("Charlie follow-up after automation");
  // Modo has NO "Send now" button on the queued follow-up.
  expect(await queueSection.getByRole("button", { name: /Send now/i }).count()).toBe(0);

  // Release the held automation turn -> Charlie's queued follow-up runs in a RECYCLED warm session (new PID)!
  NodeFS.writeFileSync(NodePath.join(projectDir, "automation-probe-release-t2"), "go\n", "utf8");
  await expect
    .poll(() => readProbeRecords(probeLogPath).length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(recordsBeforeRun2 + 2);
  const charlieFollowUpRecord = readProbeRecords(probeLogPath)[recordsBeforeRun2 + 1]!;
  expect(charlieFollowUpRecord.pid).not.toBe(autoBotRecord.pid);
  expect(charlieFollowUpRecord.mcpAuthorization).not.toBe(autoBotRecord.mcpAuthorization);

  // 9. Alice (owner) creates an elevated + locked scheduled task ->
  //    Charlie (modo) sees it Read-only (cannot edit/toggle/run/delete);
  //    elevated MCP CAN read Admin Secret thread; Alice retains explicit Interrupt revoking the GitHub lease!
  await alice.open("/settings/scheduled-tasks");
  await alice.page.getByRole("button", { name: "New task" }).click();
  const ownerDialog = alice.page.getByRole("dialog", { name: "New task" });
  await ownerDialog.waitFor({ state: "visible", timeout: 15_000 });
  await ownerDialog.locator("#scheduled-task-environment").click();
  await alice.page.getByRole("option", { name: /Automation Corp/ }).click();
  await ownerDialog.locator("#scheduled-task-title").fill("Admin Release");
  await ownerDialog.locator("#scheduled-task-workspace").click();
  await alice.page.getByRole("option", { name: "Use the project checkout" }).click();
  await ownerDialog
    .locator("#scheduled-task-prompt")
    .fill("Elevated release check HOLD_TURN:t4 DO_GIT_PUSH");
  await ownerDialog.getByTestId("scheduled-task-team-locked").click();
  await ownerDialog.getByTestId("scheduled-task-team-mcp-access").click();
  await alice.page.getByRole("option", { name: /Elevated/ }).click();
  await ownerDialog.getByRole("button", { name: "Create task" }).click();
  await ownerDialog.waitFor({ state: "hidden", timeout: 15_000 });
  await alice.page
    .getByRole("heading", { name: "Admin Release" })
    .waitFor({ state: "visible", timeout: 15_000 });

  // Charlie (modo) sees "Admin Release" as Locked + Elevated MCP + Read-only (no Run now / Delete).
  await charlie.open("/settings/scheduled-tasks");
  await charlie.page
    .getByRole("heading", { name: "Admin Release" })
    .waitFor({ state: "visible", timeout: 20_000 });
  expect(
    await charlie.page.getByRole("switch", { name: "Enable Admin Release" }).isDisabled(),
  ).toBe(true);
  await charlie.page.getByRole("button", { name: "Actions for Admin Release" }).click();
  await charlie.page
    .getByRole("menuitem", { name: "View" })
    .waitFor({ state: "visible", timeout: 10_000 });
  expect(await charlie.page.getByRole("menuitem", { name: "Run now" }).count()).toBe(0);
  expect(await charlie.page.getByRole("menuitem", { name: "Delete" }).count()).toBe(0);
  await charlie.page.keyboard.press("Escape");

  // Alice runs "Admin Release" (held open) -> elevated MCP CAN read Admin Secret thread!
  const recordsBeforeElev = readProbeRecords(probeLogPath).length;
  await alice.page.getByRole("button", { name: "Actions for Admin Release" }).click();
  await alice.page.getByRole("menuitem", { name: "Run now" }).click();
  await expect
    .poll(() => readProbeRecords(probeLogPath).length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(recordsBeforeElev + 1);
  const elevAutoRecord = readProbeRecords(probeLogPath)[recordsBeforeElev]!;
  expect(elevAutoRecord.mcpEndpoint).toBeTruthy();
  expect(elevAutoRecord.mcpAuthorization).toBeTruthy();
  const elevReadAdmin = await callMcpTool({
    request: alice.page.request,
    endpoint: elevAutoRecord.mcpEndpoint!,
    authorization: elevAutoRecord.mcpAuthorization!,
    toolName: "t3_thread_read",
    args: { threadId: adminSecretThreadId },
  });
  expect(elevReadAdmin.isError).toBe(false);

  // While held and LOCKED:
  // - The automation GitHub lease works.
  // - Charlie (modo) CANNOT interrupt a locked thread (no Interrupt button).
  // - Once Alice unlocks the thread, Charlie (modo) gets explicit Interrupt and clicking it IMMEDIATELY revokes the automation GitHub lease!
  const askpassBeforeInterrupt = queryCapturedAskpass(elevAutoRecord, fakeGitHub.origin);
  expect(askpassBeforeInterrupt.status).toBe(0);
  expect(askpassBeforeInterrupt.stdout.trim()).toBe(fakeGitHub.tokens.automation);

  expect(elevAutoRecord.t3ThreadId).toBeTruthy();
  await charlie.open(`/${topology.teamServer.environmentId}/${elevAutoRecord.t3ThreadId!}`);
  await charlie.page
    .locator("[data-user-message-bubble]")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await charlie.page
    .getByTestId("team-thread-locked-badge")
    .waitFor({ state: "visible", timeout: 15_000 });
  expect(await charlie.page.getByTestId("team-admin-interrupt-button").count()).toBe(0);
  expect(await charlie.page.getByRole("button", { name: "Stop generation" }).count()).toBe(0);

  await alice.open(`/${topology.teamServer.environmentId}/${elevAutoRecord.t3ThreadId!}`);
  const stopButton = alice.page.getByTestId("team-admin-interrupt-button");
  await stopButton.waitFor({ state: "visible", timeout: 15_000 });
  await alice.page.getByTestId("team-thread-lock-button").click();

  const charlieUnlockedInterruptBtn = charlie.page.getByTestId("team-admin-interrupt-button");
  await charlieUnlockedInterruptBtn.waitFor({ state: "visible", timeout: 15_000 });
  await charlieUnlockedInterruptBtn.click();

  await expect
    .poll(() => queryCapturedAskpass(elevAutoRecord, fakeGitHub.origin).status, { timeout: 15_000 })
    .not.toBe(0);

  // Release the held turn cleanly for process teardown.
  NodeFS.writeFileSync(NodePath.join(projectDir, "automation-probe-release-t4"), "go\n", "utf8");
});
