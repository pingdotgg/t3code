import { describe, expect, it } from "vite-plus/test";
import {
  assignableTeamRoles,
  buildTeamJoinDeepLink,
  buildTeamJoinWebUrl,
  canAssignTeamRole,
  canManageTeamInvites,
  isValidTeamPseudo,
  parseTeamJoinLink,
  shouldNotifyTeamMemberForThread,
  TeamMemberId,
} from "./schemas.ts";

describe("team role hierarchy", () => {
  it("starts invite and role management at modo and caps assignments at actor role", () => {
    expect(canManageTeamInvites("regular")).toBe(false);
    expect(canManageTeamInvites("modo")).toBe(true);
    expect(canManageTeamInvites("admin")).toBe(true);
    expect(canManageTeamInvites("owner")).toBe(true);

    expect(assignableTeamRoles("regular")).toEqual([]);
    expect(assignableTeamRoles("modo")).toEqual(["modo", "regular"]);
    expect(assignableTeamRoles("admin")).toEqual(["admin", "modo", "regular"]);
    expect(assignableTeamRoles("owner")).toEqual(["owner", "admin", "modo", "regular"]);

    expect(canAssignTeamRole("modo", "admin")).toBe(false);
    expect(canAssignTeamRole("modo", "modo")).toBe(true);
    expect(canAssignTeamRole("admin", "owner")).toBe(false);
    expect(canAssignTeamRole("owner", "owner")).toBe(true);
  });
});

describe("team pseudo validation", () => {
  it("accepts valid handles and rejects invalid formats", () => {
    expect(isValidTeamPseudo("alice")).toBe(true);
    expect(isValidTeamPseudo("  bob.dev_01-x  ")).toBe(true);
    expect(isValidTeamPseudo("a")).toBe(false);
    expect(isValidTeamPseudo("alice smith")).toBe(false);
    expect(isValidTeamPseudo("alice:bob")).toBe(false);
    expect(isValidTeamPseudo("a".repeat(33))).toBe(false);
  });
});

describe("team join links", () => {
  it("round-trips desktop deep links with optional prefilled pseudo", () => {
    const deepLink = buildTeamJoinDeepLink({
      serverUrl: "https://team.example.com:3773",
      token: "t3team_secret123",
      prefilledPseudo: "bob",
    });
    expect(deepLink).toContain("t3code://team/join?");
    expect(parseTeamJoinLink(deepLink)).toEqual({
      serverUrl: "https://team.example.com:3773",
      token: "t3team_secret123",
      prefilledPseudo: "bob",
    });
  });

  it("keeps the invite token in the URL fragment for web join links", () => {
    const webUrl = buildTeamJoinWebUrl({
      appBaseUrl: "https://app.t3.codes",
      serverUrl: "http://127.0.0.1:3773",
      token: "t3team_secret456",
      prefilledPseudo: "alice",
    });
    const parsedUrl = new URL(webUrl);
    expect(parsedUrl.pathname).toBe("/team/join");
    expect(parsedUrl.searchParams.get("token")).toBeNull();
    expect(parsedUrl.hash).toContain("token=t3team_secret456");

    expect(parseTeamJoinLink(webUrl)).toEqual({
      serverUrl: "http://127.0.0.1:3773",
      token: "t3team_secret456",
      prefilledPseudo: "alice",
    });
  });

  it("rejects non-join links and non-http server urls", () => {
    expect(parseTeamJoinLink("t3code://pair?pairingUrl=https://example.com")).toBeNull();
    expect(parseTeamJoinLink("t3code://team/join?server=javascript:alert(1)&token=abc")).toBeNull();
    expect(parseTeamJoinLink("https://app.t3.codes/team/join?server=https://x.test")).toBeNull();
  });
});

describe("shouldNotifyTeamMemberForThread", () => {
  const alice = TeamMemberId.make("member-alice");
  const bob = TeamMemberId.make("member-bob");

  it.each([
    [
      "personal mode (no team)",
      {
        hasTeam: false,
        memberId: null,
        creatorMemberId: null,
        isFollowing: false,
        activeTurnAuthorMemberId: null,
      },
      true,
    ],
    [
      "unattributed legacy thread in team mode",
      {
        hasTeam: true,
        memberId: bob,
        creatorMemberId: null,
        isFollowing: false,
        activeTurnAuthorMemberId: null,
      },
      true,
    ],
    [
      "unbound session on attributed team thread",
      {
        hasTeam: true,
        memberId: null,
        creatorMemberId: alice,
        isFollowing: false,
        activeTurnAuthorMemberId: null,
      },
      false,
    ],
    [
      "thread creator",
      {
        hasTeam: true,
        memberId: alice,
        creatorMemberId: alice,
        isFollowing: false,
        activeTurnAuthorMemberId: alice,
      },
      true,
    ],
    [
      "non-following colleague",
      {
        hasTeam: true,
        memberId: bob,
        creatorMemberId: alice,
        isFollowing: false,
        activeTurnAuthorMemberId: alice,
      },
      false,
    ],
    [
      "explicit follower",
      {
        hasTeam: true,
        memberId: bob,
        creatorMemberId: alice,
        isFollowing: true,
        activeTurnAuthorMemberId: alice,
      },
      true,
    ],
    [
      "author of completing turn in colleague thread",
      {
        hasTeam: true,
        memberId: bob,
        creatorMemberId: alice,
        isFollowing: false,
        activeTurnAuthorMemberId: bob,
      },
      true,
    ],
  ])("evaluates %s -> %s", (_label, input, expected) => {
    expect(shouldNotifyTeamMemberForThread(input)).toBe(expected);
  });
});
