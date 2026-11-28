// @effect-diagnostics nodeBuiltinImport:off -- The scenario registers a local ACP git probe and inspects bare repo commits.
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

// Minimal ACP agent that runs real `git commit`, `git push`, and `gh api` inside each turn
// using ONLY its inherited broker environment (never a static GH_TOKEN), logging results so
// the E2E scenario can verify per-turn identity forwarding, warm session recycling, and
// immediate credential lease revocation on turn completion, Interrupt, and Send now steering.
const GITHUB_PROBE_ACP = `
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const logPath = join(process.cwd(), "github-probe-turns.jsonl");
let sessionId = "github-probe-session-" + process.pid;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");

const waitForRelease = (turnNum) =>
  new Promise((resolve) => {
    const signalPath = join(process.cwd(), "github-probe-release-" + turnNum);
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
        agentInfo: { name: "GitHub Probe", version: "1.0.0" },
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

    const filePath = join(process.cwd(), "turn-" + turnNum + ".txt");
    writeFileSync(filePath, "turn " + turnNum + " pid=" + process.pid + "\\n", "utf8");

    const addRes = spawnSync("git", ["add", filePath], { cwd: process.cwd(), encoding: "utf8" });
    const commitRes = spawnSync(
      "git",
      ["commit", "-m", "Commit for turn " + turnNum],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const pushRes = spawnSync(
      "git",
      ["push", "origin", "HEAD:refs/heads/turn-" + turnNum],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const ghTokenRes = spawnSync("gh", ["auth", "token"], { cwd: process.cwd(), encoding: "utf8" });
    const ghPrRes = spawnSync(
      "gh",
      ["api", "-X", "POST", "/repos/org/repo/pulls", "-f", "title=PR turn " + turnNum],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    appendFileSync(
      logPath,
      JSON.stringify({
        turnNum,
        pid: process.pid,
        promptText,
        hasStaticGhToken: Object.prototype.hasOwnProperty.call(process.env, "GH_TOKEN"),
        hasStaticGitHubToken: Object.prototype.hasOwnProperty.call(process.env, "GITHUB_TOKEN"),
        gitAuthorName: process.env.GIT_AUTHOR_NAME ?? null,
        gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL ?? null,
        gitCommitterName: process.env.GIT_COMMITTER_NAME ?? null,
        gitCommitterEmail: process.env.GIT_COMMITTER_EMAIL ?? null,
        gitAskpass: process.env.GIT_ASKPASS ?? null,
        brokerEndpoint: process.env.T3_TEAM_GH_BROKER_ENDPOINT ?? null,
        brokerToken: process.env.T3_TEAM_GH_BROKER_TOKEN ?? null,
        t3ThreadId: process.env.T3CODE_THREAD_ID ?? null,
        pathEnv: process.env.PATH ?? "",
        addStatus: addRes.status,
        commitStatus: commitRes.status,
        commitStderr: commitRes.stderr,
        pushStatus: pushRes.status,
        pushStderr: pushRes.stderr,
        ghTokenStatus: ghTokenRes.status,
        ghPrStatus: ghPrRes.status,
        ghPrStdout: ghPrRes.stdout,
        ghPrStderr: ghPrRes.stderr,
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
          content: { type: "text", text: "GITHUB_PROBE_OK turn=" + turnNum + " pid=" + process.pid },
        },
      },
    });
    send({ id, result: { stopReason: "end_turn" } });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

interface GitHubProbeRecord {
  readonly turnNum: number;
  readonly pid: number;
  readonly promptText: string;
  readonly hasStaticGhToken: boolean;
  readonly hasStaticGitHubToken: boolean;
  readonly gitAuthorName: string | null;
  readonly gitAuthorEmail: string | null;
  readonly gitCommitterName: string | null;
  readonly gitCommitterEmail: string | null;
  readonly gitAskpass: string | null;
  readonly brokerEndpoint: string | null;
  readonly brokerToken: string | null;
  readonly t3ThreadId: string | null;
  readonly pathEnv: string;
  readonly addStatus: number | null;
  readonly commitStatus: number | null;
  readonly commitStderr: string;
  readonly pushStatus: number | null;
  readonly pushStderr: string;
  readonly ghTokenStatus: number | null;
  readonly ghPrStatus: number | null;
  readonly ghPrStdout: string;
  readonly ghPrStderr: string;
}

function readProbeRecords(logPath: string): ReadonlyArray<GitHubProbeRecord> {
  if (!NodeFS.existsSync(logPath)) return [];
  return NodeFS.readFileSync(logPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as GitHubProbeRecord);
}

function queryCapturedAskpass(record: GitHubProbeRecord, expectedOrigin: string) {
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

function queryCapturedGhToken(record: GitHubProbeRecord) {
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
  return webJoinLink;
}

test("Milestone 7: per-turn GitHub identity forwarding, warm session recycle, and immediate lease revocation on Interrupt and Send now", async ({
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

  // Create a shared Team Server project pointing at our Fake Git HTTP repository.
  const projectDir = await topology.teamServer.project(
    "team-github-repo",
    { "README.md": "# Team GitHub M7\n" },
    { gitOriginUrl: fakeGitHub.repoUrl },
  );
  const probeScriptPath = NodePath.join(topology.teamServer.home, "github-probe-acp.mjs");
  NodeFS.writeFileSync(probeScriptPath, GITHUB_PROBE_ACP, "utf8");
  const probeLogPath = NodePath.join(projectDir, "github-probe-turns.jsonl");
  const probeInstanceId = ProviderInstanceId.make("github-probe");

  // Register our GitHub Probe ACP agent and set it as default model on Team Server.
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
            displayName: "GitHub Probe",
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

  // 1. Alice pairs with Team Server, initializes team, invites Bob, and Bob joins.
  await alice.pairWithRemoteServer({
    host: topology.teamServer.origin,
    pairingToken: topology.teamServer.pairingToken,
  });
  await alice.open("/settings/teams");
  await alice.page.getByTestId("team-server-select").click();
  await alice.page.getByRole("option", { name: /Team Server/ }).click();
  await alice.page.getByTestId("team-init-name").fill("Acme GitHub M7");
  await alice.page.getByTestId("team-init-pseudo").fill("alice");
  await alice.page.getByTestId("team-init-submit").click();
  await alice.page
    .getByTestId("teams-settings-tabs")
    .waitFor({ state: "visible", timeout: 20_000 });

  const bobJoinLink = await createInviteAndJoin({
    inviter: alice,
    invitee: bob,
    roleLabel: "Regular",
    pseudo: "bob",
  });
  expect(bobJoinLink.length).toBeGreaterThan(0);

  // 2. Alice connects PAT_ALICE in Settings -> Teams -> GitHub identity (verified against Fake GitHub API).
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

  // Alice (owner) can also configure & clear the optional Team Automation GitHub account.
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
  await alice.page.getByTestId("team-automation-github-clear").click();
  await confirmDestructiveActionDialog(alice.page);
  await expect
    .poll(
      async () =>
        (await alice.page
          .getByTestId("team-automation-github-status")
          .textContent()
          .catch(() => "")) ?? "",
      { timeout: 15_000 },
    )
    .toContain("None");

  // 3. Bob (regular) connects PAT_BOB in Settings -> Teams:
  //    - Does NOT see Alice's GitHub identity
  //    - Does NOT see the admin-only Team Automation GitHub section
  await bob.open("/settings/teams");
  await selectTeamSettingsTab(bob.page, "providers");
  await bob.page
    .getByTestId("team-my-github-token-input")
    .waitFor({ state: "visible", timeout: 20_000 });
  expect(await bob.page.getByTestId("team-automation-github-token-input").count()).toBe(0);
  expect(await bob.page.getByTestId("team-my-github-card").count()).toBe(0);

  await bob.page.getByTestId("team-my-github-advanced-toggle").click();
  await bob.page.getByTestId("team-my-github-api-url-input").fill(fakeGitHub.origin);
  await bob.page.getByTestId("team-my-github-token-input").fill(fakeGitHub.tokens.bob);
  await bob.page.getByTestId("team-my-github-save").click();
  await expect
    .poll(
      async () =>
        (await bob.page
          .getByTestId("team-my-github-login")
          .textContent()
          .catch(() => "")) ?? "",
      { timeout: 15_000 },
    )
    .toContain("@bob-gh");

  fakeGitHub.reset();

  // 4. Turn 1 (Alice): start a thread on Team Server, commit + push + create PR via gh wrapper.
  await alice.open("/");
  const aliceColleaguesToggle = alice.page.getByTestId("team-colleagues-toggle");
  await aliceColleaguesToggle.waitFor({ state: "visible", timeout: 15_000 });
  if ((await aliceColleaguesToggle.getAttribute("aria-pressed")) !== "true") {
    await aliceColleaguesToggle.click();
  }
  await expect
    .poll(async () => await aliceColleaguesToggle.getAttribute("aria-pressed"), { timeout: 10_000 })
    .toBe("true");
  await alice.page.getByRole("button", { name: "New thread" }).first().click();
  const aliceComposer = alice.page.locator('[contenteditable="true"]').first();
  await aliceComposer.waitFor({ state: "visible", timeout: 15_000 });
  await aliceComposer.click();
  await aliceComposer.fill("Alice GitHub Turn 1");
  await aliceComposer.press("Enter");

  await expect
    .poll(() => readProbeRecords(probeLogPath).length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(1);
  // Wait for Turn 1 to finish
  await expect
    .poll(async () => await alice.page.getByRole("button", { name: "Stop generation" }).count(), {
      timeout: 20_000,
    })
    .toBe(0);

  const turn1 = readProbeRecords(probeLogPath)[0]!;
  expect(turn1.hasStaticGhToken).toBe(false);
  expect(turn1.hasStaticGitHubToken).toBe(false);
  expect(turn1.gitAuthorName).toBe("Alice Owner");
  expect(turn1.gitAuthorEmail).toBe("alice@test.example");
  expect(turn1.commitStatus, turn1.commitStderr).toBe(0);
  expect(turn1.pushStatus, turn1.pushStderr).toBe(0);
  expect(turn1.ghTokenStatus).toBe(0);
  expect(turn1.ghPrStatus, turn1.ghPrStderr).toBe(0);

  // Verify bare repo commit author & Fake Git HTTP + GitHub API tokens used PAT_ALICE!
  const turn1Log = NodeChildProcess.spawnSync(
    "git",
    [
      "--git-dir",
      fakeGitHub.bareRepoPath,
      "log",
      "-1",
      "--format=%an|%ae|%cn|%ce|%s",
      "refs/heads/turn-1",
    ],
    { encoding: "utf8" },
  );
  expect(turn1Log.status).toBe(0);
  expect(turn1Log.stdout.trim()).toBe(
    "Alice Owner|alice@test.example|Alice Owner|alice@test.example|Commit for turn 1",
  );
  expect(fakeGitHub.gitRequests().some((r) => r.token === fakeGitHub.tokens.alice)).toBe(true);
  expect(fakeGitHub.createdPullRequests()[0]).toMatchObject({
    title: "PR turn 1",
    authorLogin: "alice-gh",
    token: fakeGitHub.tokens.alice,
  });

  // After Turn 1 settled, Alice's captured broker token MUST fail closed (no active turn lease)!
  expect(queryCapturedAskpass(turn1, fakeGitHub.origin).status).not.toBe(0);
  expect(queryCapturedGhToken(turn1).status).not.toBe(0);

  // 5. Turn 2 (Bob) on the EXACT SAME thread:
  //    Warm provider session MUST recycle (different PID), commits as Bob, authenticates with PAT_BOB!
  await bob.open("/");
  await bob.page.getByTestId("team-colleagues-toggle").click();
  const bobThreadRow = bob.page
    .locator("aside, [data-sidebar='sidebar']")
    .first()
    .locator("[data-sidebar-row]", { hasText: "Alice GitHub Turn 1" })
    .first();
  await expect
    .poll(async () => (await bobThreadRow.textContent().catch(() => "")) ?? "", { timeout: 20_000 })
    .toContain("alice: Alice GitHub Turn 1");
  await bobThreadRow.focus();
  await bobThreadRow.press("Enter");

  const bobComposer = bob.page.locator('[contenteditable="true"]').first();
  await bobComposer.waitFor({ state: "visible", timeout: 15_000 });
  await bobComposer.click();
  await bobComposer.fill("Bob GitHub Turn 2");
  await bobComposer.press("Enter");

  await expect
    .poll(() => readProbeRecords(probeLogPath).length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(async () => await bob.page.getByRole("button", { name: "Stop generation" }).count(), {
      timeout: 20_000,
    })
    .toBe(0);

  const turn2 = readProbeRecords(probeLogPath)[1]!;
  expect(turn2.pid).not.toBe(turn1.pid);
  expect(turn2.hasStaticGhToken).toBe(false);
  expect(turn2.hasStaticGitHubToken).toBe(false);
  expect(turn2.gitAuthorName).toBe("Bob Regular");
  expect(turn2.gitAuthorEmail).toBe("bob@test.example");
  expect(turn2.commitStatus).toBe(0);
  expect(turn2.pushStatus).toBe(0);
  expect(turn2.ghPrStatus).toBe(0);

  const turn2Log = NodeChildProcess.spawnSync(
    "git",
    [
      "--git-dir",
      fakeGitHub.bareRepoPath,
      "log",
      "-1",
      "--format=%an|%ae|%cn|%ce|%s",
      "refs/heads/turn-2",
    ],
    { encoding: "utf8" },
  );
  expect(turn2Log.status).toBe(0);
  expect(turn2Log.stdout.trim()).toBe(
    "Bob Regular|bob@test.example|Bob Regular|bob@test.example|Commit for turn 2",
  );
  expect(fakeGitHub.gitRequests().some((r) => r.token === fakeGitHub.tokens.bob)).toBe(true);
  expect(fakeGitHub.createdPullRequests()[1]).toMatchObject({
    title: "PR turn 2",
    authorLogin: "bob-gh",
    token: fakeGitHub.tokens.bob,
  });

  // 6. Mid-turn Send now (creator Alice steering Bob's foreign-authored active turn):
  //    Bob starts Turn 3 with HOLD_TURN -> Bob's token is live while running.
  //    Alice (thread creator) queues a message and clicks Send now -> Bob's GitHub lease is IMMEDIATELY revoked!
  await bobComposer.click();
  await bobComposer.fill("Bob HOLD_TURN 3");
  await bobComposer.press("Enter");

  await expect
    .poll(() => readProbeRecords(probeLogPath).length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(3);
  const turn3 = readProbeRecords(probeLogPath)[2]!;
  // While Turn 3 is actively running, Bob's broker lease works:
  expect(queryCapturedGhToken(turn3).stdout.trim()).toBe(fakeGitHub.tokens.bob);

  // Thread creator Alice queues a message (or sees Send now) and clicks Send now to steer Bob's turn:
  await aliceComposer.click();
  await aliceComposer.fill("Alice creator steer on Bob turn");
  await aliceComposer.press("Enter");
  const sendNowButton = alice.page.getByTestId("queued-send-now-button");
  if ((await sendNowButton.count()) > 0) {
    await sendNowButton.click();
  }
  // Bob's foreign-authored active turn GitHub credential lease is IMMEDIATELY revoked!
  await expect.poll(() => queryCapturedGhToken(turn3).status, { timeout: 15_000 }).not.toBe(0);
  expect(queryCapturedAskpass(turn3, fakeGitHub.origin).status).not.toBe(0);

  // Release Turn 3 probe so thread settles cleanly (and wait for Alice's steered turn to settle too).
  NodeFS.writeFileSync(
    NodePath.join(projectDir, `github-probe-release-${turn3.turnNum}`),
    "ok",
    "utf8",
  );
  await expect
    .poll(async () => await bob.page.getByRole("button", { name: "Stop generation" }).count(), {
      timeout: 20_000,
    })
    .toBe(0);
  await expect
    .poll(async () => await alice.page.getByRole("button", { name: "Stop generation" }).count(), {
      timeout: 20_000,
    })
    .toBe(0);

  // 7. Admin/Owner Interrupt immediately revokes another member's active turn GitHub lease:
  //    Bob starts a new thread with HOLD_TURN (Turn 4), Alice (owner) opens Bob's thread,
  //    verifies Interrupt button, clicks Interrupt -> Bob's active turn lease is IMMEDIATELY revoked!
  const sharedThreadUrl = bob.page.url();
  await bob.page.getByRole("button", { name: "New thread" }).first().click();
  await expect.poll(() => bob.page.url(), { timeout: 15_000 }).not.toBe(sharedThreadUrl);
  await bobComposer.waitFor({ state: "visible", timeout: 15_000 });
  await bobComposer.click();
  await bobComposer.fill("Bob own thread HOLD_TURN 4");
  await bobComposer.press("Enter");

  const bobSidebar = bob.page.locator("aside, [data-sidebar='sidebar']").first();
  await expect
    .poll(async () => (await bobSidebar.textContent({ timeout: 1_000 }).catch(() => "")) ?? "", {
      timeout: 20_000,
    })
    .toContain("bob: Bob own thread HOLD_TURN 4");

  await expect
    .poll(() => readProbeRecords(probeLogPath).some((r) => r.promptText.includes("HOLD_TURN 4")), {
      timeout: 25_000,
    })
    .toBe(true);
  const turn4 = readProbeRecords(probeLogPath).find((r) => r.promptText.includes("HOLD_TURN 4"))!;
  expect(queryCapturedGhToken(turn4).stdout.trim()).toBe(fakeGitHub.tokens.bob);

  // Actively running colleague threads live inside the collapsed "Working" shelf until expanded.
  const aliceSidebar = alice.page.locator("aside, [data-sidebar='sidebar']").first();
  const workingShelfBtn = alice.page.getByTestId("sidebar-working-shelf-toggle");
  await expect
    .poll(
      async () => (await workingShelfBtn.textContent({ timeout: 1_000 }).catch(() => "")) ?? "",
      {
        timeout: 20_000,
      },
    )
    .toContain("1");
  if ((await workingShelfBtn.getAttribute("aria-expanded")) !== "true") {
    await workingShelfBtn.focus();
    await workingShelfBtn.press("Enter");
  }
  await expect
    .poll(async () => await workingShelfBtn.getAttribute("aria-expanded"), { timeout: 5_000 })
    .toBe("true");

  await expect
    .poll(
      async () => {
        const rows = await alice.page.locator("[data-sidebar-row]").allTextContents();
        return rows.join(" || ");
      },
      { timeout: 10_000 },
    )
    .toContain("Bob own thread HOLD_TURN 4");
  const aliceBobRow = aliceSidebar
    .locator("[data-sidebar-row]", { hasText: "Bob own thread HOLD_TURN 4" })
    .first();
  await aliceBobRow.focus();
  await aliceBobRow.press("Enter");

  const adminInterruptBtn = alice.page.getByTestId("team-admin-interrupt-button");
  await adminInterruptBtn.waitFor({ state: "visible", timeout: 20_000 });
  await adminInterruptBtn.click();

  // Immediately revoked even BEFORE Turn 4 probe script exits!
  await expect.poll(() => queryCapturedGhToken(turn4).status, { timeout: 15_000 }).not.toBe(0);
  expect(queryCapturedAskpass(turn4, fakeGitHub.origin).status).not.toBe(0);

  NodeFS.writeFileSync(
    NodePath.join(projectDir, `github-probe-release-${turn4.turnNum}`),
    "ok",
    "utf8",
  );
});
