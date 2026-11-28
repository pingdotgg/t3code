import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  parseTeamJoinLink,
} from "@t3tools/contracts";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { startTeamTopology, type TeamMemberHandle } from "./topology.ts";
import { openTeamInviteForm, selectTeamSettingsTab } from "./ui-helpers.ts";

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
    const composerText = await page
      .locator('[contenteditable="true"]')
      .first()
      .textContent()
      .catch(() => "<missing>");
    const alerts = await page.locator('[role="alert"], [data-slot="toast"]').allTextContents();
    throw new Error(
      `waitForAssistantTurnSettled(${label}) failed (url=${url}, assistantCount=${assistantCount}, expected>=${minAssistantMessages}, userMessages=${JSON.stringify(userMessages)}, composerText=${JSON.stringify(composerText)}, alerts=${JSON.stringify(alerts)}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
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

test("enforces team RBAC, server-side Views read/post rules, live revocation, and thread locking across Alice (owner), Charlie (modo), and Bob (regular)", async ({
  app,
}) => {
  await using topology = await startTeamTopology({
    viteUrl: app.baseUrl ?? "",
    members: [
      { pseudo: "alice", role: "owner" },
      { pseudo: "charlie", role: "modo" },
      { pseudo: "bob", role: "regular" },
    ],
  });

  const alice = topology.member("alice");
  const charlie = topology.member("charlie");
  const bob = topology.member("bob");

  await topology.teamServer.project("team-app");

  // 1. Alice pairs with the Team Server, initializes the team, and invites Charlie (modo) and Bob (regular).
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

  // Also mint a raw regular-member Bearer token (no DPoP) to test direct HTTP API enforcement
  // bypassing the UI completely.
  await alice.page.getByTestId("team-invite-role-select").click();
  await alice.page.getByRole("option", { name: "Regular" }).click();
  await alice.page.getByTestId("team-invite-pseudo-input").fill("eve");
  await alice.page.getByTestId("team-invite-create").click();
  await alice.page
    .getByTestId("team-invite-generated")
    .waitFor({ state: "visible", timeout: 15_000 });
  await expect
    .poll(async () => await alice.page.getByTestId("team-invite-weblink").inputValue(), {
      timeout: 15_000,
    })
    .toContain("pseudo=eve");
  const eveJoinLink = await alice.page.getByTestId("team-invite-weblink").inputValue();
  const eveParsed = parseTeamJoinLink(eveJoinLink);
  expect(eveParsed).not.toBeNull();
  const eveToken = eveParsed!.token;
  const eveRedeemResponse = await alice.page.request.post(
    `${topology.teamServer.origin}/api/team/invites/redeem`,
    {
      headers: { "content-type": "application/json" },
      data: { token: eveToken, pseudo: "eve" },
    },
  );
  expect(eveRedeemResponse.status()).toBe(200);
  const eveAuth = (await eveRedeemResponse.json()) as {
    readonly accessToken: string;
    readonly tokenType: string;
  };
  expect(eveAuth.tokenType).toBe("Bearer");

  // Verify Alice sees all members in Settings -> Teams -> Members, with last-owner protection on herself.
  await alice.page
    .getByTestId("team-member-charlie")
    .waitFor({ state: "visible", timeout: 15_000 });
  await alice.page.getByTestId("team-member-bob").waitFor({ state: "visible", timeout: 15_000 });
  expect(await alice.page.getByTestId("team-member-role-select-alice").count()).toBe(0);
  expect(await alice.page.getByTestId("team-member-role-select-bob").count()).toBe(1);

  // 2. Alice creates two custom Views:
  //    - "Staff Only": read = owner/admin/modo, post = owner/admin/modo
  //    - "Announcements": read = all, post = owner/admin/modo
  await selectTeamSettingsTab(alice.page, "access");
  await alice.page.getByTestId("team-view-create-open").click();
  await alice.page.getByTestId("team-view-name-input").fill("Staff Only");
  await alice.page.getByTestId("team-view-read-role-regular").click();
  await alice.page.getByTestId("team-view-post-role-regular").click();
  await alice.page.getByTestId("team-view-save").click();
  await alice.page
    .getByTestId("team-view-row-Staff Only")
    .waitFor({ state: "visible", timeout: 15_000 });

  await alice.page.getByTestId("team-view-create-open").click();
  await alice.page.getByTestId("team-view-name-input").fill("Announcements");
  await alice.page.getByTestId("team-view-post-role-regular").click();
  await alice.page.getByTestId("team-view-save").click();
  await alice.page
    .getByTestId("team-view-row-Announcements")
    .waitFor({ state: "visible", timeout: 15_000 });

  // Verify Bob (regular) cannot create views or manage roles in Settings -> Teams.
  await bob.open("/settings/teams");
  await bob.page.getByTestId("team-member-charlie").waitFor({ state: "visible", timeout: 15_000 });
  expect(await bob.page.getByTestId("team-member-role-select-charlie").count()).toBe(0);
  await selectTeamSettingsTab(bob.page, "access");
  await bob.page.getByTestId("team-views-section").waitFor({ state: "visible", timeout: 15_000 });
  expect(await bob.page.getByTestId("team-view-create-open").count()).toBe(0);
  expect(await bob.page.getByTestId("team-view-row-Staff Only").count()).toBe(0);
  expect(await bob.page.getByTestId("team-view-row-Announcements").count()).toBe(1);

  // 3. Enable colleagues view for Charlie and Bob on the main workspace.
  for (const member of [charlie, bob]) {
    await member.open("/");
    await member.page
      .getByTestId("team-colleagues-toggle")
      .waitFor({ state: "visible", timeout: 15_000 });
    await member.page.getByTestId("team-colleagues-toggle").click();
  }

  // Alice starts a thread in Default View ("Secret roadmap").
  await alice.open("/");
  await alice.page
    .getByTestId("team-colleagues-toggle")
    .waitFor({ state: "visible", timeout: 15_000 });
  await alice.page.getByRole("button", { name: "New thread" }).first().click();

  const aliceComposer = alice.page.locator('[contenteditable="true"]').first();
  await aliceComposer.waitFor({ state: "visible", timeout: 15_000 });
  await aliceComposer.click();
  await aliceComposer.fill("Secret roadmap");
  await aliceComposer.press("Enter");

  await expect
    .poll(
      async () =>
        (await alice.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "",
      { timeout: 20_000 },
    )
    .toContain("alice: Secret roadmap");
  await waitForAssistantTurnSettled(alice.page, 1, "alice-secret-turn1");

  const secretThreadPath = new URL(alice.page.url()).pathname;
  const secretThreadId = secretThreadPath.split("/").filter(Boolean).at(-1) ?? "";
  expect(secretThreadId.length).toBeGreaterThan(0);

  // Bob sees Alice's Default-View thread live and opens it.
  const bobSecretRow = bob.page
    .locator("aside, [data-sidebar='sidebar']")
    .first()
    .locator("[data-sidebar-row]", { hasText: "Secret roadmap" })
    .first();
  await expect
    .poll(async () => (await bobSecretRow.textContent().catch(() => "")) ?? "", { timeout: 20_000 })
    .toContain("alice: Secret roadmap");
  await bobSecretRow.focus();
  await bobSecretRow.press("Enter");
  await waitForAssistantTurnSettled(bob.page, 1, "bob-read-secret");

  // Charlie (modo) opens the thread and moves it to "Staff Only" via the header View pill.
  const charlieSecretRow = charlie.page
    .locator("aside, [data-sidebar='sidebar']")
    .first()
    .locator("[data-sidebar-row]", { hasText: "Secret roadmap" })
    .first();
  await expect
    .poll(async () => (await charlieSecretRow.textContent().catch(() => "")) ?? "", {
      timeout: 20_000,
    })
    .toContain("alice: Secret roadmap");
  await charlieSecretRow.focus();
  await charlieSecretRow.press("Enter");
  await charlie.page
    .getByTestId("team-thread-view-pill")
    .waitFor({ state: "visible", timeout: 15_000 });
  await charlie.page.getByTestId("team-thread-view-pill").click();
  await charlie.page.getByTestId("team-thread-view-option-Staff Only").click();

  // Live revocation: thread disappears immediately from Bob's sidebar AND Bob's open transcript BEFORE reload.
  await expect
    .poll(
      async () =>
        (await bob.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "",
      { timeout: 20_000 },
    )
    .not.toContain("Secret roadmap");
  await expect
    .poll(async () => (await bob.page.locator("body").textContent()) ?? "", { timeout: 15_000 })
    .not.toContain("Secret roadmap");

  // Direct URL navigation by Bob cannot load the restricted thread (server rejects subscribeThread).
  await bob.page.goto(`${bob.origin}${secretThreadPath}`, { waitUntil: "domcontentloaded" });
  await expect
    .poll(async () => (await bob.page.locator("body").textContent()) ?? "", { timeout: 15_000 })
    .not.toContain("Secret roadmap");
  await bob.open("/");

  // Direct HTTP API reads by a regular member (bypassing the UI) return HTTP 403 team_thread_access_denied.
  const regularAuthHeaders = {
    authorization: `Bearer ${eveAuth.accessToken}`,
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  };
  const directSnapshotRes = await bob.page.request.get(
    `${topology.teamServer.origin}/api/orchestration/threads/${encodeURIComponent(secretThreadId)}`,
    { headers: regularAuthHeaders },
  );
  expect(directSnapshotRes.status()).toBe(403);
  const directBoundedRes = await bob.page.request.get(
    `${topology.teamServer.origin}/api/orchestration/threads/${encodeURIComponent(secretThreadId)}/bounded`,
    { headers: regularAuthHeaders },
  );
  expect(directBoundedRes.status()).toBe(403);
  const directTranscriptRes = await bob.page.request.get(
    `${topology.teamServer.origin}/api/orchestration/threads/${encodeURIComponent(secretThreadId)}/transcript`,
    { headers: regularAuthHeaders },
  );
  expect(directTranscriptRes.status()).toBe(403);

  // 4. Alice creates a thread in "Announcements" -> Bob can read it, sees read-only composer, cannot post.
  await alice.page.getByRole("button", { name: "New thread" }).first().click();
  await alice.page
    .getByTestId("team-draft-view-select")
    .waitFor({ state: "visible", timeout: 15_000 });
  await alice.page.getByTestId("team-draft-view-select").click();
  await alice.page.getByTestId("team-draft-view-option-Announcements").click();
  await aliceComposer.click();
  await aliceComposer.fill("Quarterly release notes");
  await aliceComposer.press("Enter");
  await expect
    .poll(
      async () =>
        (await alice.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "",
      { timeout: 20_000 },
    )
    .toContain("alice: Quarterly release notes");
  await waitForAssistantTurnSettled(alice.page, 1, "alice-announcement-turn1");

  const bobAnnouncementRow = bob.page
    .locator("aside, [data-sidebar='sidebar']")
    .first()
    .locator("[data-sidebar-row]", { hasText: "Quarterly release notes" })
    .first();
  await expect
    .poll(async () => (await bobAnnouncementRow.textContent().catch(() => "")) ?? "", {
      timeout: 20_000,
    })
    .toContain("alice: Quarterly release notes");
  await bobAnnouncementRow.focus();
  await bobAnnouncementRow.press("Enter");
  await waitForAssistantTurnSettled(bob.page, 1, "bob-read-announcement");

  const bobReadOnlyBanner = bob.page.getByTestId("team-composer-readonly-banner");
  await bobReadOnlyBanner.waitFor({ state: "visible", timeout: 15_000 });
  expect(await bobReadOnlyBanner.getAttribute("data-reason")).toBe("view_read_only");

  // 5. Bob creates his OWN thread in "Announcements" and posts a follow-up in it.
  await bob.page.getByRole("button", { name: "New thread" }).first().click();
  await bob.page
    .getByTestId("team-draft-view-select")
    .waitFor({ state: "visible", timeout: 15_000 });
  await bob.page.getByTestId("team-draft-view-select").click();
  await bob.page.getByTestId("team-draft-view-option-Announcements").click();
  expect(await bob.page.getByTestId("team-draft-lock-toggle").count()).toBe(0);

  const bobComposer = bob.page.locator('[contenteditable="true"]').first();
  await bobComposer.click();
  await bobComposer.fill("Bob announcement proposal");
  await bobComposer.press("Enter");

  await expect
    .poll(
      async () =>
        (await bob.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "",
      { timeout: 20_000 },
    )
    .toContain("bob: Bob announcement proposal");
  await waitForAssistantTurnSettled(bob.page, 1, "bob-own-turn1");
  expect(await bob.page.getByTestId("team-composer-readonly-banner").count()).toBe(0);
  const assistantCountBeforeBobTurn2 = await bob.page
    .locator('[data-message-role="assistant"]')
    .count();

  // Bob posts a follow-up turn in his own unlocked thread in Announcements.
  await bobComposer.click();
  await bobComposer.fill("Bob follow-up details");
  await bobComposer.press("Enter");
  await waitForAssistantTurnSettled(bob.page, assistantCountBeforeBobTurn2 + 1, "bob-own-turn2");
  const assistantCountAfterBobTurn2 = await bob.page
    .locator('[data-message-role="assistant"]')
    .count();

  // 6. Alice (owner) opens Bob's thread and locks it -> Bob is immediately blocked, Alice can still post!
  await alice.page.getByTestId("team-colleagues-toggle").click();
  const aliceBobRow = alice.page
    .locator("aside, [data-sidebar='sidebar']")
    .first()
    .locator("[data-sidebar-row]", { hasText: "Bob announcement proposal" })
    .first();
  await expect
    .poll(async () => (await aliceBobRow.textContent().catch(() => "")) ?? "", { timeout: 20_000 })
    .toContain("bob: Bob announcement proposal");
  await aliceBobRow.focus();
  await aliceBobRow.press("Enter");
  await waitForAssistantTurnSettled(
    alice.page,
    assistantCountAfterBobTurn2,
    "alice-open-bob-thread",
  );

  const lockButton = alice.page.getByTestId("team-thread-lock-button");
  await lockButton.waitFor({ state: "visible", timeout: 15_000 });
  await lockButton.click();
  await expect
    .poll(async () => await lockButton.getAttribute("data-locked"), { timeout: 15_000 })
    .toBe("true");

  // Bob's browser immediately shows the Locked badge and switches his composer to locked read-only.
  await bob.page
    .getByTestId("team-thread-locked-badge")
    .waitFor({ state: "visible", timeout: 15_000 });
  await expect
    .poll(
      async () =>
        await bob.page
          .getByTestId("team-composer-readonly-banner")
          .getAttribute("data-reason")
          .catch(() => null),
      { timeout: 15_000 },
    )
    .toBe("locked");

  // Alice (owner) can still post in Bob's locked thread, and Bob sees Alice's message live.
  expect(await alice.page.getByTestId("team-composer-readonly-banner").count()).toBe(0);
  await aliceComposer.click();
  await aliceComposer.fill("Owner final decision");
  await aliceComposer.press("Enter");
  await expect
    .poll(
      async () =>
        (await alice.page.locator('[data-message-role="user"]').allTextContents()).join("\n"),
      { timeout: 20_000 },
    )
    .toContain("Owner final decision");
  await expect
    .poll(
      async () =>
        (await bob.page.locator('[data-message-role="user"]').allTextContents()).join("\n"),
      { timeout: 20_000 },
    )
    .toContain("Owner final decision");
  await expect
    .poll(async () => await bob.page.getByRole("button", { name: "Stop generation" }).count(), {
      timeout: 25_000,
    })
    .toBe(0);
});
