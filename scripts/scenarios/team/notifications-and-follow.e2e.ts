import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { startTeamTopology } from "./topology.ts";
import { openTeamInviteForm } from "./ui-helpers.ts";

test("team notifications stay silent for unfollowed colleague threads, fire while followed, and silence again after unfollow", async ({
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

  // 1. Alice pairs with the Team Server, initializes the team, and invites Bob.
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

  await openTeamInviteForm(alice.page);
  await alice.page.getByTestId("team-invite-pseudo-input").fill("bob");
  await alice.page.getByTestId("team-invite-create").click();
  await alice.page
    .getByTestId("team-invite-generated")
    .waitFor({ state: "visible", timeout: 15_000 });

  const aliceWebJoinLink = await alice.page.getByTestId("team-invite-weblink").inputValue();
  const parsedWebJoinUrl = new URL(aliceWebJoinLink);
  const bobJoinUrl = `${bob.origin}${parsedWebJoinUrl.pathname}${parsedWebJoinUrl.search}${parsedWebJoinUrl.hash}`;

  // 2. Bob redeems the invite and enables desktop notifications in Settings.
  await bob.page.goto(bobJoinUrl, { waitUntil: "domcontentloaded" });
  await bob.page.getByTestId("team-join-preview").waitFor({ state: "visible", timeout: 15_000 });
  await bob.page.getByTestId("team-join-submit").click();
  await bob.page
    .getByTestId("team-colleagues-toggle")
    .waitFor({ state: "visible", timeout: 20_000 });

  await bob.open("/settings/general");
  const notificationSelect = bob.page.getByLabel("Thread notifications");
  await notificationSelect.waitFor({ state: "visible", timeout: 15_000 });
  await notificationSelect.click();
  await bob.page.getByRole("option", { name: "Notifications only" }).click();

  // Navigate Bob back to the main workspace, enable colleagues view BEFORE Turn 1 so his sidebar
  // reflects Alice's thread live, then simulate an unfocused window.
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

  // 3. Alice starts a thread and runs Turn 1 on the Team Server -> Bob must receive 0 notifications.
  await alice.open("/");
  await alice.page
    .getByTestId("team-colleagues-toggle")
    .waitFor({ state: "visible", timeout: 15_000 });
  await alice.page.getByRole("button", { name: "New thread" }).first().click();

  const aliceComposer = alice.page.locator('[contenteditable="true"]').first();
  await aliceComposer.waitFor({ state: "visible", timeout: 15_000 });
  await aliceComposer.click();
  await aliceComposer.fill("Release checklist");
  await aliceComposer.press("Enter");

  const waitForAssistantTurnSettled = async (
    page: typeof alice.page,
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

  // Wait for Alice's thread to appear in Alice's sidebar and finish its first replay turn.
  await expect
    .poll(
      async () =>
        (await alice.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "",
      { timeout: 20_000 },
    )
    .toContain("alice: Release checklist");
  await waitForAssistantTurnSettled(alice.page, 1);

  // Confirm Alice's own thread does NOT show a Follow button in her header.
  expect(await alice.page.getByTestId("team-thread-follow-button").count()).toBe(0);

  // While Bob's window is STILL unfocused, confirm his live client receives Alice's thread and
  // completed Turn 1 output, and verify he recorded 0 notifications for Alice's unfollowed Turn 1.
  const bobThreadRow = bob.page
    .locator("aside, [data-sidebar='sidebar']")
    .first()
    .locator("[data-sidebar-row]", { hasText: "Release checklist" })
    .first();
  await expect
    .poll(async () => (await bobThreadRow.textContent().catch(() => "")) ?? "", {
      timeout: 20_000,
    })
    .toContain("alice: Release checklist");
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
  ).toContain("alice: Release checklist");

  // 5. Bob unfocuses his window; Alice runs Turn 2 -> Bob receives a notification!
  const assistantCountBeforeTurn2 = await alice.page
    .locator('[data-message-role="assistant"]')
    .count();
  await bob.clearNotifications();
  await bob.setWindowFocused(false);

  await aliceComposer.click();
  await aliceComposer.fill("Second update for followers");
  await aliceComposer.press("Enter");
  await waitForAssistantTurnSettled(alice.page, assistantCountBeforeTurn2 + 1);

  await expect
    .poll(async () => (await bob.notifications()).length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(1);
  const afterFollowNotifications = await bob.notifications();
  expect(afterFollowNotifications.some((n) => n.body.includes("alice: Release checklist"))).toBe(
    true,
  );

  // 6. Bob clicks Unfollow, clears notifications, unfocuses window; Alice runs Turn 3 -> Bob receives 0 new notifications.
  await bob.setWindowFocused(true);
  await followButton.click();
  await expect
    .poll(async () => await followButton.getAttribute("aria-pressed"), { timeout: 15_000 })
    .toBe("false");
  const assistantCountBeforeTurn3 = await alice.page
    .locator('[data-message-role="assistant"]')
    .count();
  await bob.clearNotifications();
  await bob.setWindowFocused(false);

  await aliceComposer.click();
  await aliceComposer.fill("Third update after unfollow");
  await aliceComposer.press("Enter");

  // Wait for Turn 3 to finish on Alice's side and land in Bob's live thread view so we know sync completed.
  await waitForAssistantTurnSettled(alice.page, assistantCountBeforeTurn3 + 1);
  await waitForAssistantTurnSettled(bob.page, assistantCountBeforeTurn3 + 1);

  // Bob's browser received the live Turn 3 updates and still recorded 0 notifications.
  expect(await bob.notifications()).toEqual([]);
});
