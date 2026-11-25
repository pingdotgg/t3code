import { describe, expect, it } from "vite-plus/test";
import {
  assignableTeamRoles,
  buildTeamJoinDeepLink,
  buildTeamJoinWebUrl,
  canAssignTeamRole,
  canChangeTeamMemberRole,
  canChangeThreadTeamView,
  canManageTeamInvites,
  canManageTeamViews,
  canMemberCreateThreadInTeamView,
  canMemberPostInTeamThread,
  canMemberReadTeamThread,
  canModifyTeamMember,
  canToggleTeamThreadLock,
  isValidTeamPseudo,
  parseTeamJoinLink,
  resolveTeamThreadPostBlockReason,
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

    expect(canModifyTeamMember("regular", "regular")).toBe(false);
    expect(canModifyTeamMember("modo", "regular")).toBe(true);
    expect(canModifyTeamMember("modo", "modo")).toBe(true);
    expect(canModifyTeamMember("modo", "admin")).toBe(false);
    expect(canModifyTeamMember("admin", "owner")).toBe(false);
    expect(canChangeTeamMemberRole("modo", "regular", "modo")).toBe(true);
    expect(canChangeTeamMemberRole("modo", "admin", "regular")).toBe(false);
    expect(canChangeTeamMemberRole("admin", "modo", "owner")).toBe(false);

    expect(canManageTeamViews("regular")).toBe(false);
    expect(canManageTeamViews("modo")).toBe(false);
    expect(canManageTeamViews("admin")).toBe(true);
    expect(canManageTeamViews("owner")).toBe(true);

    expect(canChangeThreadTeamView("regular")).toBe(false);
    expect(canChangeThreadTeamView("modo")).toBe(true);
    expect(canToggleTeamThreadLock("modo")).toBe(false);
    expect(canToggleTeamThreadLock("admin")).toBe(true);
  });
});

describe("team view read/post and locking rules", () => {
  const owner = {
    id: TeamMemberId.make("m-owner"),
    role: "owner" as const,
    status: "active" as const,
  };
  const admin = {
    id: TeamMemberId.make("m-admin"),
    role: "admin" as const,
    status: "active" as const,
  };
  const modo = {
    id: TeamMemberId.make("m-modo"),
    role: "modo" as const,
    status: "active" as const,
  };
  const regular = {
    id: TeamMemberId.make("m-regular"),
    role: "regular" as const,
    status: "active" as const,
  };
  const suspended = {
    id: TeamMemberId.make("m-suspended"),
    role: "admin" as const,
    status: "suspended" as const,
  };

  const adminOnlyView = {
    readRule: { roles: ["owner", "admin"] as const, memberIds: [] as const },
    postRule: { roles: ["owner", "admin"] as const, memberIds: [] as const },
  };
  const readOnlyForRegularView = {
    readRule: { roles: ["owner", "admin", "modo", "regular"] as const, memberIds: [] as const },
    postRule: { roles: ["owner", "admin", "modo"] as const, memberIds: [] as const },
  };
  const memberWhitelistedView = {
    readRule: { roles: ["admin"] as const, memberIds: [regular.id] as const },
    postRule: { roles: ["admin"] as const, memberIds: [] as const },
  };

  it("enforces view readRule while keeping owner/admin visibility and blocking inactive members", () => {
    expect(canMemberReadTeamThread({ member: owner, view: adminOnlyView })).toBe(true);
    expect(canMemberReadTeamThread({ member: admin, view: adminOnlyView })).toBe(true);
    expect(canMemberReadTeamThread({ member: modo, view: adminOnlyView })).toBe(false);
    expect(canMemberReadTeamThread({ member: regular, view: adminOnlyView })).toBe(false);
    expect(canMemberReadTeamThread({ member: suspended, view: readOnlyForRegularView })).toBe(
      false,
    );
    expect(canMemberReadTeamThread({ member: regular, view: memberWhitelistedView })).toBe(true);
  });

  it("allows creating unlocked threads in readable views and restricts locked creation to owner/admin", () => {
    expect(canMemberCreateThreadInTeamView(regular, readOnlyForRegularView, false)).toBe(true);
    expect(canMemberCreateThreadInTeamView(regular, readOnlyForRegularView, true)).toBe(false);
    expect(canMemberCreateThreadInTeamView(modo, readOnlyForRegularView, true)).toBe(false);
    expect(canMemberCreateThreadInTeamView(admin, readOnlyForRegularView, true)).toBe(true);
    expect(canMemberCreateThreadInTeamView(regular, adminOnlyView, false)).toBe(false);
  });

  it("enforces postRule on colleagues while allowing creators on unlocked threads and only owner/admin on locked threads", () => {
    // Creator can post in own unlocked thread even when view.postRule excludes their role.
    expect(
      canMemberPostInTeamThread({
        member: regular,
        attribution: { creatorMemberId: regular.id, locked: false },
        view: readOnlyForRegularView,
      }),
    ).toBe(true);

    // Colleague without postRule cannot post in another's thread.
    expect(
      resolveTeamThreadPostBlockReason({
        member: regular,
        attribution: { creatorMemberId: owner.id, locked: false },
        view: readOnlyForRegularView,
      }),
    ).toBe("view_read_only");

    // Locking overrides even the thread creator (regular or modo).
    expect(
      resolveTeamThreadPostBlockReason({
        member: regular,
        attribution: { creatorMemberId: regular.id, locked: true },
        view: readOnlyForRegularView,
      }),
    ).toBe("locked");
    expect(
      resolveTeamThreadPostBlockReason({
        member: modo,
        attribution: { creatorMemberId: modo.id, locked: true },
        view: readOnlyForRegularView,
      }),
    ).toBe("locked");
    expect(
      resolveTeamThreadPostBlockReason({
        member: admin,
        attribution: { creatorMemberId: regular.id, locked: true },
        view: readOnlyForRegularView,
      }),
    ).toBe("ok");
    expect(
      resolveTeamThreadPostBlockReason({
        member: owner,
        attribution: { creatorMemberId: regular.id, locked: true },
        view: readOnlyForRegularView,
      }),
    ).toBe("ok");
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
