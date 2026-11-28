import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { startTeamTopology } from "./topology.ts";
import { openTeamInviteForm } from "./ui-helpers.ts";

test("following and snoozing Charlie’s thread changes notifications only for the acting member", async ({
  app,
}) => {
  await using topology = await startTeamTopology({
    viteUrl: app.baseUrl ?? "",
    members: [
      { pseudo: "charlie", role: "owner" },
      { pseudo: "alice", role: "regular" },
      { pseudo: "bob", role: "regular" },
    ],
  });

  const charlie = topology.member("charlie");
  const bob = topology.member("bob");
  const alice = topology.member("alice");

  await topology.teamServer.project("team-app");

  // 1. Charlie pairs with the Team Server, initializes the team, and invites Bob.
  await charlie.pairWithRemoteServer({
    host: topology.teamServer.origin,
    pairingToken: topology.teamServer.pairingToken,
  });

  await charlie.open("/settings/teams");
  await charlie.page.getByTestId("team-server-select").click();
  await charlie.page.getByRole("option", { name: /Team Server/ }).click();

  await charlie.page.getByTestId("team-init-name").fill("Acme Engineering");
  await charlie.page.getByTestId("team-init-pseudo").fill("charlie");
  await charlie.page.getByTestId("team-init-submit").click();
  await charlie.page
    .getByTestId("team-member-charlie")
    .waitFor({ state: "visible", timeout: 15_000 });

  for (const [pseudo, member] of [
    ["alice", alice],
    ["bob", bob],
  ] as const) {
    await openTeamInviteForm(charlie.page);
    await charlie.page.getByTestId("team-invite-pseudo-input").fill(pseudo);
    await charlie.page.getByTestId("team-invite-create").click();
    const joinLink = charlie.page.getByTestId("team-invite-weblink");
    await expect.poll(() => joinLink.inputValue()).toContain(`pseudo=${pseudo}`);
    const url = new URL(await joinLink.inputValue());
    await member.page.goto(`${member.origin}${url.pathname}${url.search}${url.hash}`, {
      waitUntil: "domcontentloaded",
    });
    await member.page.getByTestId("team-join-submit").click();
    await member.page.getByTestId("team-colleagues-toggle").waitFor({ state: "visible" });
  }

  await bob.open("/settings/general");
  const notificationSelect = bob.page.getByLabel("Thread notifications");
  await notificationSelect.waitFor({ state: "visible", timeout: 15_000 });
  await notificationSelect.click();
  await bob.page.getByRole("option", { name: "Notifications only" }).click();

  // Navigate Bob back to the main workspace, enable colleagues view BEFORE Turn 1 so his sidebar
  // reflects Charlie's thread live, then simulate an unfocused window.
  await bob.open("/");
  await bob.page
    .getByTestId("team-colleagues-toggle")
    .waitFor({ state: "visible", timeout: 15_000 });
  await bob.page.getByTestId("team-colleagues-toggle").click();
  expect(await bob.page.getByTestId("team-colleagues-toggle").getAttribute("aria-pressed")).toBe(
    "true",
  );
  await bob.clearNotifications();
  await bob.setWindowFocused(false);

  // 3. Charlie starts a thread and runs Turn 1 on the Team Server -> Bob must receive 0 notifications.
  await charlie.open("/");
  await charlie.page
    .getByTestId("team-colleagues-toggle")
    .waitFor({ state: "visible", timeout: 15_000 });
  await charlie.page.getByRole("button", { name: "New thread" }).first().click();

  const charlieComposer = charlie.page.locator('[contenteditable="true"]').first();
  await charlieComposer.waitFor({ state: "visible", timeout: 15_000 });
  await charlieComposer.click();
  await charlieComposer.fill("Release checklist");
  await charlieComposer.press("Enter");

  const waitForAssistantTurnSettled = async (
    page: typeof charlie.page,
    minAssistantMessages: number,
  ) => {
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
  };

  // Wait for Charlie's thread to appear in Charlie's sidebar and finish its first replay turn.
  await expect
    .poll(
      async () =>
        (await charlie.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "",
      { timeout: 20_000 },
    )
    .toContain("charlie: Release checklist");
  await waitForAssistantTurnSettled(charlie.page, 1);

  // Confirm Charlie's own thread does NOT show a Follow button in her header.
  expect(await charlie.page.getByTestId("team-thread-follow-button").count()).toBe(0);

  // While Bob's window is STILL unfocused, confirm his live client receives Charlie's thread and
  // completed Turn 1 output, and verify he recorded 0 notifications for Charlie's unfollowed Turn 1.
  const bobThreadRow = bob.page
    .locator("aside, [data-sidebar='sidebar']")
    .first()
    .locator("[data-sidebar-row]", { hasText: "Release checklist" })
    .first();
  await expect
    .poll(async () => (await bobThreadRow.textContent().catch(() => "")) ?? "", {
      timeout: 20_000,
    })
    .toContain("charlie: Release checklist");
  await bobThreadRow.focus();
  await bobThreadRow.press("Enter");
  await waitForAssistantTurnSettled(bob.page, 1);
  expect(await bob.notifications()).toEqual([]);

  // 4. Bob refocuses and clicks Follow in the thread header.
  await bob.setWindowFocused(true);

  const followButton = bob.page.getByTestId("team-thread-follow-button");
  await followButton.waitFor({ state: "visible", timeout: 15_000 });
  expect(await followButton.getAttribute("aria-pressed")).toBe("false");
  await followButton.click();
  await expect
    .poll(async () => await followButton.getAttribute("aria-pressed"), { timeout: 15_000 })
    .toBe("true");

  // Verify the sidebar shows the followed badge, Followed filter turns on, and Colleagues toggle turns off (mutually exclusive).
  await bob.page
    .getByTestId("team-thread-followed-badge")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await bob.page.getByTestId("team-followed-filter-toggle").click();
  expect(
    await bob.page.getByTestId("team-followed-filter-toggle").getAttribute("aria-pressed"),
  ).toBe("true");
  expect(await bob.page.getByTestId("team-colleagues-toggle").getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(
    (await bob.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "",
  ).toContain("charlie: Release checklist");

  await alice.open("/settings/general");
  await alice.page.getByRole("switch", { name: "In-app notifications" }).click();
  await alice.open("/");
  await alice.page.getByTestId("team-colleagues-toggle").click();
  const aliceThreadRow = alice.page
    .locator("[data-sidebar-row]", { hasText: "Release checklist" })
    .first();
  await aliceThreadRow.press("Enter");
  const aliceFollow = alice.page.getByTestId("team-thread-follow-button");
  await aliceFollow.click();
  await expect.poll(() => aliceFollow.getAttribute("aria-pressed")).toBe("true");
  await alice.open("/");
  await alice.setWindowFocused(true);

  // 5. Bob unfocuses his window; Charlie runs Turn 2 -> Bob receives a notification!
  const assistantCountBeforeTurn2 = await charlie.page
    .locator('[data-message-role="assistant"]')
    .count();
  await bob.clearNotifications();
  await bob.setWindowFocused(false);

  await charlieComposer.click();
  await charlieComposer.fill("Second update for followers");
  await charlieComposer.press("Enter");
  await waitForAssistantTurnSettled(charlie.page, assistantCountBeforeTurn2 + 1);

  await expect
    .poll(async () => (await bob.notifications()).length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(1);
  const afterFollowNotifications = await bob.notifications();
  expect(afterFollowNotifications.some((n) => n.body.includes("charlie: Release checklist"))).toBe(
    true,
  );

  await alice.page.getByRole("button", { name: "Snooze", exact: true }).click();
  await alice.page.getByRole("button", { name: /^Snoozed/ }).click();
  await aliceThreadRow
    .getByRole("button", { name: "Wake thread now" })
    .waitFor({ state: "attached" });
  expect(await bobThreadRow.getByRole("button", { name: "Wake thread now" }).count()).toBe(0);

  await alice.clearNotifications();
  await bob.clearNotifications();
  await alice.setWindowFocused(false);
  const beforeSnoozedTurn = await charlie.page.locator('[data-message-role="assistant"]').count();
  await charlieComposer.fill("Third update while Alice snoozes");
  await charlieComposer.press("Enter");
  await waitForAssistantTurnSettled(charlie.page, beforeSnoozedTurn + 1);
  await expect.poll(async () => (await bob.notifications()).length).toBeGreaterThan(0);
  expect(await alice.notifications()).toEqual([]);
  await aliceThreadRow
    .getByRole("button", { name: "Wake thread now" })
    .waitFor({ state: "attached" });

  // 6. Bob clicks Unfollow, clears notifications, unfocuses window; Charlie runs Turn 3 -> Bob receives 0 new notifications.
  await bob.setWindowFocused(true);
  await followButton.click();
  await expect
    .poll(async () => await followButton.getAttribute("aria-pressed"), { timeout: 15_000 })
    .toBe("false");
  const assistantCountBeforeTurn3 = await charlie.page
    .locator('[data-message-role="assistant"]')
    .count();
  await bob.clearNotifications();
  await bob.setWindowFocused(false);

  await charlieComposer.click();
  await charlieComposer.fill("Third update after unfollow");
  await charlieComposer.press("Enter");

  // Wait for Turn 3 to finish on Charlie's side and land in Bob's live thread view so we know sync completed.
  await waitForAssistantTurnSettled(charlie.page, assistantCountBeforeTurn3 + 1);
  await waitForAssistantTurnSettled(bob.page, assistantCountBeforeTurn3 + 1);

  // Bob's browser received the live Turn 3 updates and still recorded 0 notifications.
  expect(await bob.notifications()).toEqual([]);
});
