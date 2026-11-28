import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { startTeamTopology } from "./topology.ts";
import { openTeamInviteForm } from "./ui-helpers.ts";

test("deep-link invite with prefilled pseudo, pseudo prefixing, and colleagues thread filter across two live apps", async ({
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

  // 1. Alice links her local app to the shared Team Server and initializes the team.
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

  // 2. Alice generates an invite for Bob with prefilled pseudo "bob".
  await openTeamInviteForm(alice.page);
  await alice.page.getByTestId("team-invite-pseudo-input").fill("bob");
  await alice.page.getByTestId("team-invite-create").click();
  await alice.page
    .getByTestId("team-invite-generated")
    .waitFor({ state: "visible", timeout: 15_000 });

  const aliceDeepLink = await alice.page.getByTestId("team-invite-deeplink").inputValue();
  expect(aliceDeepLink.startsWith("t3code://team/join?")).toBe(true);

  const aliceWebJoinLink = await alice.page.getByTestId("team-invite-weblink").inputValue();
  const parsedWebJoinUrl = new URL(aliceWebJoinLink);
  // Generated shareable web links point to the hosted app origin, never the sender's loopback or t3code://app.
  expect(parsedWebJoinUrl.protocol).toBe("https:");
  expect(parsedWebJoinUrl.pathname).toBe("/team/join");

  // Test Bob redeeming the web-fragment join route served by Bob's local app origin.
  const bobJoinUrl = `${bob.origin}${parsedWebJoinUrl.pathname}${parsedWebJoinUrl.search}${parsedWebJoinUrl.hash}`;

  // 3. Bob redeems the web join link in his isolated browser + local app.
  await bob.page.goto(bobJoinUrl, { waitUntil: "domcontentloaded" });
  await bob.page.getByTestId("team-join-preview").waitFor({ state: "visible", timeout: 15_000 });
  expect(await bob.page.getByTestId("team-join-preview").textContent()).toContain(
    "Acme Engineering",
  );
  expect(await bob.page.getByTestId("team-join-pseudo-input").inputValue()).toBe("bob");
  await bob.page.getByTestId("team-join-submit").click();

  await bob.page
    .getByTestId("team-colleagues-toggle")
    .waitFor({ state: "visible", timeout: 20_000 });
  expect(await bob.page.getByTestId("team-colleagues-toggle").getAttribute("aria-pressed")).toBe(
    "false",
  );

  // 4. Alice starts a thread on the Team Server through her browser UI.
  await alice.open("/");
  await alice.page
    .getByTestId("team-colleagues-toggle")
    .waitFor({ state: "visible", timeout: 15_000 });
  await alice.page.getByRole("button", { name: "New thread" }).first().click();

  const aliceComposer = alice.page.locator('[contenteditable="true"]').first();
  await aliceComposer.waitFor({ state: "visible", timeout: 15_000 });
  await aliceComposer.click();
  await aliceComposer.fill("Fix login bug");
  await aliceComposer.press("Enter");

  // 5. Alice sees her thread dynamically prefixed as "alice: Fix login bug".
  await expect
    .poll(
      async () =>
        (await alice.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "",
      { timeout: 20_000 },
    )
    .toContain("alice: Fix login bug");

  // 6. Bob starts his own thread on the Team Server to prove his live WS sync is caught up,
  //    then verifies his sidebar shows his own thread while hiding Alice's thread by default.
  await bob.page.getByRole("button", { name: "New thread" }).first().click();
  const bobComposer = bob.page.locator('[contenteditable="true"]').first();
  await bobComposer.waitFor({ state: "visible", timeout: 15_000 });
  await bobComposer.click();
  await bobComposer.fill("Bob personal task");
  await bobComposer.press("Enter");

  await expect
    .poll(
      async () =>
        (await bob.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "",
      { timeout: 20_000 },
    )
    .toContain("bob: Bob personal task");

  const bobSidebarWhileFiltered =
    (await bob.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "";
  expect(bobSidebarWhileFiltered).not.toContain("Fix login bug");
  expect(await bob.notifications()).toEqual([]);

  // 7. Bob toggles colleagues' threads on -> Alice's prefixed thread appears live alongside Bob's.
  await bob.page.getByTestId("team-colleagues-toggle").click();
  expect(await bob.page.getByTestId("team-colleagues-toggle").getAttribute("aria-pressed")).toBe(
    "true",
  );
  await expect
    .poll(
      async () =>
        (await bob.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "",
      { timeout: 15_000 },
    )
    .toContain("alice: Fix login bug");

  // 8. Bob toggles colleagues' threads off -> Alice's thread hides again while Bob's remains visible.
  await bob.page.getByTestId("team-colleagues-toggle").click();
  expect(await bob.page.getByTestId("team-colleagues-toggle").getAttribute("aria-pressed")).toBe(
    "false",
  );
  await expect
    .poll(
      async () =>
        (await bob.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "",
      { timeout: 15_000 },
    )
    .not.toContain("Fix login bug");
  expect(
    (await bob.page.locator("aside, [data-sidebar='sidebar']").first().textContent()) ?? "",
  ).toContain("bob: Bob personal task");
});
