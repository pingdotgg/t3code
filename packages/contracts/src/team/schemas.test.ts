import { describe, expect, it } from "vite-plus/test";
import {
  assignableTeamRoles,
  buildTeamJoinDeepLink,
  buildTeamJoinWebUrl,
  canAssignTeamRole,
  canChangeTeamMemberRole,
  canChangeThreadTeamView,
  canManagePrivilegedTeamScheduledTasks,
  canManageTeamAutomationGitHub,
  canManageTeamDisplayName,
  canManageTeamEnvironments,
  canManageTeamInvites,
  canManageTeamPreprompts,
  canManageTeamProjects,
  canManageTeamProviders,
  canManageTeamScheduledTasks,
  canManageTeamSkills,
  canManageTeamViews,
  canMemberMutateTeamScheduledTask,
  canMemberReadTeamScheduledTask,
  canMemberSeeTeamScheduledTaskWebhook,
  resolveScheduledTaskScope,
  resolveTeamDisplayName,
  defaultTeamProviderDeliveryStrategy,
  isTeamProviderInstanceId,
  isTeamProviderInstanceIdForTeam,
  makeTeamProviderInstanceId,
  parseTeamProviderInstanceId,
  canMemberAccessTeamEnvironment,
  canMemberCreateThreadInTeamView,
  canMemberInterruptTeamTurn,
  canMemberLeaveTeamThreadNote,
  canMemberManageTeamQueuedRun,
  canMemberPostInTeamThread,
  canMemberPromoteTeamQueuedRun,
  canMemberReadTeamThread,
  canMemberRespondToTeamRuntimeRequest,
  canMemberSteerActiveTeamTurn,
  canModifyTeamMember,
  canToggleTeamThreadLock,
  effectiveTeamThreadNoteBody,
  effectiveTeamThreadNoteHash,
  formatAcceptedTeamNoteForPrompt,
  isValidTeamPseudo,
  parseTeamJoinLink,
  requiresTeamNoteApprovalConfirmation,
  resolveTeamQueuedMessageNotificationRecipients,
  resolveTeamThreadEnvironmentAccess,
  resolveTeamThreadPostBlockReason,
  shouldNotifyTeamMemberForThread,
  TeamId,
  TeamMemberId,
  TeamThreadNoteId,
  type TeamRole,
} from "./schemas.ts";
import { EnvironmentId, ThreadId } from "../baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "../providerInstance.ts";

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

  it("enforces creator-only Send now / steering, owner/admin explicit Interrupt, and queued run management", () => {
    const defaultView = {
      readRule: { roles: ["owner", "admin", "modo", "regular"] as const, memberIds: [] as const },
      postRule: { roles: ["owner", "admin", "modo", "regular"] as const, memberIds: [] as const },
    };
    const bobAttribution = { creatorMemberId: regular.id, locked: false };
    const bobLockedAttribution = { creatorMemberId: regular.id, locked: true };

    // Send now / steer active turn is STRICTLY creator-only (even owner/admin cannot steer Bob's thread).
    expect(
      canMemberPromoteTeamQueuedRun({
        member: regular,
        attribution: bobAttribution,
        view: defaultView,
      }),
    ).toBe(true);
    expect(
      canMemberPromoteTeamQueuedRun({
        member: owner,
        attribution: bobAttribution,
        view: defaultView,
      }),
    ).toBe(false);
    expect(
      canMemberPromoteTeamQueuedRun({
        member: admin,
        attribution: bobAttribution,
        view: defaultView,
      }),
    ).toBe(false);
    expect(
      canMemberPromoteTeamQueuedRun({
        member: modo,
        attribution: bobAttribution,
        view: defaultView,
      }),
    ).toBe(false);
    // Locked thread blocks even the creator from steering/promoting.
    expect(
      canMemberPromoteTeamQueuedRun({
        member: regular,
        attribution: bobLockedAttribution,
        view: defaultView,
      }),
    ).toBe(false);
    expect(
      canMemberSteerActiveTeamTurn({
        member: owner,
        attribution: bobAttribution,
        view: defaultView,
      }),
    ).toBe(false);
    expect(
      canMemberSteerActiveTeamTurn({
        member: regular,
        attribution: bobAttribution,
        view: defaultView,
      }),
    ).toBe(true);

    // Interrupt: owner/admin can interrupt any readable thread (including locked);
    // modo can interrupt unlocked readable threads (not locked); regular can interrupt own unlocked thread or own active turn.
    const lockedBobAttribution = { ...bobAttribution, locked: true };
    const adminOnlyView = {
      readRule: { roles: ["owner", "admin"] as TeamRole[], memberIds: [] },
      postRule: { roles: ["owner", "admin"] as TeamRole[], memberIds: [] },
    };
    const otherRegular = {
      ...regular,
      id: TeamMemberId.make("m-regular-2"),
    };
    expect(
      canMemberInterruptTeamTurn({
        member: owner,
        attribution: bobAttribution,
        view: defaultView,
        activeTurnAuthorMemberId: regular.id,
      }),
    ).toBe(true);
    expect(
      canMemberInterruptTeamTurn({
        member: admin,
        attribution: lockedBobAttribution,
        view: defaultView,
        activeTurnAuthorMemberId: regular.id,
      }),
    ).toBe(true);
    expect(
      canMemberInterruptTeamTurn({
        member: regular,
        attribution: bobAttribution,
        view: defaultView,
        activeTurnAuthorMemberId: modo.id,
      }),
    ).toBe(true);
    expect(
      canMemberInterruptTeamTurn({
        member: regular,
        attribution: lockedBobAttribution,
        view: defaultView,
        activeTurnAuthorMemberId: owner.id,
      }),
    ).toBe(false);
    expect(
      canMemberInterruptTeamTurn({
        member: regular,
        attribution: lockedBobAttribution,
        view: defaultView,
        activeTurnAuthorMemberId: regular.id,
      }),
    ).toBe(true);
    expect(
      canMemberInterruptTeamTurn({
        member: modo,
        attribution: bobAttribution,
        view: defaultView,
        activeTurnAuthorMemberId: modo.id,
      }),
    ).toBe(true);
    expect(
      canMemberInterruptTeamTurn({
        member: modo,
        attribution: bobAttribution,
        view: defaultView,
        activeTurnAuthorMemberId: regular.id,
      }),
    ).toBe(true);
    expect(
      canMemberInterruptTeamTurn({
        member: modo,
        attribution: lockedBobAttribution,
        view: defaultView,
        activeTurnAuthorMemberId: regular.id,
      }),
    ).toBe(false);
    expect(
      canMemberInterruptTeamTurn({
        member: modo,
        attribution: bobAttribution,
        view: adminOnlyView,
        activeTurnAuthorMemberId: regular.id,
      }),
    ).toBe(false);
    expect(
      canMemberInterruptTeamTurn({
        member: otherRegular,
        attribution: bobAttribution,
        view: defaultView,
        activeTurnAuthorMemberId: regular.id,
      }),
    ).toBe(false);
    expect(
      canMemberInterruptTeamTurn({
        member: suspended,
        attribution: bobAttribution,
        view: defaultView,
        activeTurnAuthorMemberId: regular.id,
      }),
    ).toBe(false);
    // Runtime request responses stay restricted to owner/admin, thread creator (unlocked), or active turn author (never modo on foreign turns).
    expect(
      canMemberRespondToTeamRuntimeRequest({
        member: modo,
        attribution: bobAttribution,
        view: defaultView,
        activeTurnAuthorMemberId: regular.id,
      }),
    ).toBe(false);
    expect(
      canMemberRespondToTeamRuntimeRequest({
        member: owner,
        attribution: bobAttribution,
        view: defaultView,
        activeTurnAuthorMemberId: regular.id,
      }),
    ).toBe(true);

    // Queued run management (edit/cancel): owner/admin, thread creator (if can post), or queued run author (if can post).
    expect(
      canMemberManageTeamQueuedRun({
        member: owner,
        attribution: bobAttribution,
        view: defaultView,
        queuedRunAuthorMemberId: modo.id,
      }),
    ).toBe(true);
    expect(
      canMemberManageTeamQueuedRun({
        member: modo,
        attribution: bobAttribution,
        view: defaultView,
        queuedRunAuthorMemberId: modo.id,
      }),
    ).toBe(true);
    expect(
      canMemberManageTeamQueuedRun({
        member: modo,
        attribution: bobAttribution,
        view: defaultView,
        queuedRunAuthorMemberId: regular.id,
      }),
    ).toBe(false);
    expect(
      canMemberManageTeamQueuedRun({
        member: regular,
        attribution: bobLockedAttribution,
        view: defaultView,
        queuedRunAuthorMemberId: regular.id,
      }),
    ).toBe(false);
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

describe("Milestone 5 environments, local boundary, and thread notes", () => {
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

  it("gates environment and project management to owner/admin and requires confirmation only for regular note authors", () => {
    expect(canManageTeamEnvironments("owner")).toBe(true);
    expect(canManageTeamEnvironments("admin")).toBe(true);
    expect(canManageTeamEnvironments("modo")).toBe(false);
    expect(canManageTeamEnvironments("regular")).toBe(false);

    expect(canManageTeamProjects("owner")).toBe(true);
    expect(canManageTeamProjects("admin")).toBe(true);
    expect(canManageTeamProjects("modo")).toBe(false);
    expect(canManageTeamProjects("regular")).toBe(false);

    expect(requiresTeamNoteApprovalConfirmation("regular")).toBe(true);
    expect(requiresTeamNoteApprovalConfirmation("modo")).toBe(false);
    expect(requiresTeamNoteApprovalConfirmation("admin")).toBe(false);
    expect(requiresTeamNoteApprovalConfirmation("owner")).toBe(false);
  });

  it("enforces per-environment ACLs and the absolute local-execution boundary (even against owner/admin)", () => {
    const restrictedEnv = {
      environmentId: EnvironmentId.make("env-gpu"),
      name: "GPU Runner",
      isDefault: false,
      accessRule: { roles: ["owner", "admin"] as const, memberIds: [modo.id] as const },
    };
    expect(canMemberAccessTeamEnvironment(owner, restrictedEnv)).toBe(true);
    expect(canMemberAccessTeamEnvironment(admin, restrictedEnv)).toBe(true);
    expect(canMemberAccessTeamEnvironment(modo, restrictedEnv)).toBe(true);
    expect(canMemberAccessTeamEnvironment(regular, restrictedEnv)).toBe(false);

    const bobLocalAttr = {
      creatorMemberId: regular.id,
      creatorPseudo: "bob" as never,
      isLocalSynced: true,
      executionEnvironmentId: EnvironmentId.make("env-bob-laptop"),
      executionEnvironmentLabel: "Bob Laptop",
    };
    // Even owner and admin cannot execute on Bob's local-synced thread!
    expect(
      resolveTeamThreadEnvironmentAccess({
        member: owner,
        attribution: bobLocalAttr,
        environments: [restrictedEnv],
      }),
    ).toMatchObject({ canExecute: false, reason: "other_member_local" });
    expect(
      resolveTeamThreadEnvironmentAccess({
        member: admin,
        attribution: bobLocalAttr,
        environments: [restrictedEnv],
      }),
    ).toMatchObject({ canExecute: false, reason: "other_member_local" });
    // Bob himself viewing his own mirrored thread on the Team Server gets own_local_mirror (P1-7).
    expect(
      resolveTeamThreadEnvironmentAccess({
        member: regular,
        attribution: bobLocalAttr,
        environments: [restrictedEnv],
        viewingOnLocalExecutionEnvironment: false,
      }),
    ).toMatchObject({ canExecute: false, reason: "own_local_mirror" });
    // Bob himself can execute only when viewing on his local execution environment.
    expect(
      resolveTeamThreadEnvironmentAccess({
        member: regular,
        attribution: bobLocalAttr,
        environments: [restrictedEnv],
        viewingOnLocalExecutionEnvironment: true,
      }),
    ).toEqual({ canExecute: true, reason: "ok" });
    // Remote restricted environment denies regular.
    expect(
      resolveTeamThreadEnvironmentAccess({
        member: regular,
        attribution: {
          creatorMemberId: owner.id,
          creatorPseudo: "alice" as never,
          isLocalSynced: false,
          executionEnvironmentId: restrictedEnv.environmentId,
        },
        environments: [restrictedEnv],
      }),
    ).toMatchObject({ canExecute: false, reason: "environment_acl_denied" });
  });

  it("gates note leaving by lock and view.postRule and formats attributed prompt blocks", () => {
    const openView = {
      readRule: { roles: ["owner", "admin", "modo", "regular"] as const, memberIds: [] as const },
      postRule: { roles: ["owner", "admin", "modo", "regular"] as const, memberIds: [] as const },
    };
    const readOnlyView = {
      readRule: { roles: ["owner", "admin", "modo", "regular"] as const, memberIds: [] as const },
      postRule: { roles: ["owner", "admin"] as const, memberIds: [] as const },
    };
    expect(
      canMemberLeaveTeamThreadNote({
        member: regular,
        attribution: { creatorMemberId: owner.id, locked: false },
        view: openView,
      }),
    ).toBe(true);
    expect(
      canMemberLeaveTeamThreadNote({
        member: regular,
        attribution: { creatorMemberId: owner.id, locked: true },
        view: openView,
      }),
    ).toBe(false);
    expect(
      canMemberLeaveTeamThreadNote({
        member: owner,
        attribution: { creatorMemberId: regular.id, locked: true },
        view: openView,
      }),
    ).toBe(true);
    expect(
      canMemberLeaveTeamThreadNote({
        member: regular,
        attribution: { creatorMemberId: owner.id, locked: false },
        view: readOnlyView,
      }),
    ).toBe(false);

    const baseNote = {
      id: TeamThreadNoteId.make("note-1"),
      threadId: ThreadId.make("t-1"),
      teamId: TeamId.make("team-1"),
      authorMemberId: regular.id,
      authorPseudo: "bob" as never,
      authorRole: "regular" as const,
      originalBody: "Try running tests with --runInBand",
      originalContentHash: "hash-orig",
      editedBody: null,
      editedContentHash: null,
      status: "accepted" as const,
      anchorTurnId: "run-1",
      anchorSeq: 1,
      includedInTurnId: null,
      resolvedByMemberId: owner.id,
      resolvedByPseudo: "alice" as never,
      resolvedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(effectiveTeamThreadNoteBody(baseNote)).toBe("Try running tests with --runInBand");
    expect(effectiveTeamThreadNoteHash(baseNote)).toBe("hash-orig");
    expect(formatAcceptedTeamNoteForPrompt({ ...baseNote, approverPseudo: "alice" })).toBe(
      "[Note from bob (approved by alice)]: Try running tests with --runInBand",
    );

    const editedNote = {
      ...baseNote,
      editedBody: "Run only unit tests first",
      editedContentHash: "hash-edit",
    };
    expect(effectiveTeamThreadNoteBody(editedNote)).toBe("Run only unit tests first");
    expect(effectiveTeamThreadNoteHash(editedNote)).toBe("hash-edit");
    expect(formatAcceptedTeamNoteForPrompt({ ...editedNote, approverPseudo: "alice" })).toBe(
      "[Note from bob (edited & approved by alice)]: Run only unit tests first",
    );
  });
});

describe("Milestone 6 team providers, skills, and pre-prompts contracts", () => {
  it("restricts provider management to owner/admin and skills/pre-prompts to modo+", () => {
    expect(canManageTeamProviders("owner")).toBe(true);
    expect(canManageTeamProviders("admin")).toBe(true);
    expect(canManageTeamProviders("modo")).toBe(false);
    expect(canManageTeamProviders("regular")).toBe(false);

    expect(canManageTeamSkills("owner")).toBe(true);
    expect(canManageTeamSkills("admin")).toBe(true);
    expect(canManageTeamSkills("modo")).toBe(true);
    expect(canManageTeamSkills("regular")).toBe(false);

    expect(canManageTeamPreprompts("owner")).toBe(true);
    expect(canManageTeamPreprompts("admin")).toBe(true);
    expect(canManageTeamPreprompts("modo")).toBe(true);
    expect(canManageTeamPreprompts("regular")).toBe(false);
  });

  it("constructs and parses virtual team:<teamId>:<providerInstanceId> identifiers", () => {
    const teamA = TeamId.make("team-alpha_1");
    const teamB = TeamId.make("team-beta_2");
    const source = ProviderInstanceId.make("antigravity");
    const virtualId = makeTeamProviderInstanceId(teamA, source);
    expect(virtualId).toBe("team:team-alpha_1:antigravity");
    expect(isTeamProviderInstanceId(virtualId)).toBe(true);
    expect(isTeamProviderInstanceId("antigravity")).toBe(false);
    expect(isTeamProviderInstanceIdForTeam(virtualId, teamA)).toBe(true);
    expect(isTeamProviderInstanceIdForTeam(virtualId, teamB)).toBe(false);
    expect(parseTeamProviderInstanceId(virtualId)).toEqual({
      teamId: teamA,
      sourceInstanceId: source,
    });
    expect(parseTeamProviderInstanceId("codex")).toBeNull();
  });

  it("classifies default delivery strategies safely", () => {
    expect(
      defaultTeamProviderDeliveryStrategy(ProviderDriverKind.make("claudeAgent"), {
        hasUpstreamBaseUrl: true,
      }),
    ).toBe("proxy");
    expect(defaultTeamProviderDeliveryStrategy(ProviderDriverKind.make("antigravity"))).toBe(
      "token-lease",
    );
    expect(defaultTeamProviderDeliveryStrategy(ProviderDriverKind.make("codex"))).toBe(
      "token-lease",
    );
    expect(defaultTeamProviderDeliveryStrategy(ProviderDriverKind.make("claudeAgent"))).toBe(
      "token-lease",
    );
    expect(defaultTeamProviderDeliveryStrategy(ProviderDriverKind.make("cursor"))).toBe(
      "remote-only",
    );
    expect(defaultTeamProviderDeliveryStrategy(ProviderDriverKind.make("kiro"))).toBe(
      "remote-only",
    );
  });

  it("restricts team automation GitHub configuration to owner and admin", () => {
    expect(canManageTeamAutomationGitHub("owner")).toBe(true);
    expect(canManageTeamAutomationGitHub("admin")).toBe(true);
    expect(canManageTeamAutomationGitHub("modo")).toBe(false);
    expect(canManageTeamAutomationGitHub("regular")).toBe(false);
  });
});

describe("Milestone 8 team displayName, scheduled-task scoping & RBAC, and team-owned threads", () => {
  const owner = {
    id: TeamMemberId.make("m8-owner"),
    role: "owner" as const,
    status: "active" as const,
  };
  const admin = {
    id: TeamMemberId.make("m8-admin"),
    role: "admin" as const,
    status: "active" as const,
  };
  const modo = {
    id: TeamMemberId.make("m8-modo"),
    role: "modo" as const,
    status: "active" as const,
  };
  const regular = {
    id: TeamMemberId.make("m8-regular"),
    role: "regular" as const,
    status: "active" as const,
  };
  const openEnv = {
    accessRule: { roles: ["owner", "admin", "modo", "regular"] as const, memberIds: [] },
  };
  const adminEnv = {
    accessRule: { roles: ["owner", "admin"] as const, memberIds: [] },
  };
  const openView = {
    readRule: { roles: ["owner", "admin", "modo", "regular"] as const, memberIds: [] },
    postRule: { roles: ["owner", "admin", "modo", "regular"] as const, memberIds: [] },
  };
  const readOnlyView = {
    readRule: { roles: ["owner", "admin", "modo", "regular"] as const, memberIds: [] },
    postRule: { roles: ["owner", "admin"] as const, memberIds: [] },
  };
  const adminView = {
    readRule: { roles: ["owner", "admin"] as const, memberIds: [] },
    postRule: { roles: ["owner", "admin"] as const, memberIds: [] },
  };

  it("resolves team displayName (defaulting to name) and hidden personal scheduled-task scope", () => {
    expect(resolveTeamDisplayName("Acme Corp", undefined)).toBe("Acme Corp");
    expect(resolveTeamDisplayName("Acme Corp", "   ")).toBe("Acme Corp");
    expect(resolveTeamDisplayName("Acme Corp", "  Acme Bot  ")).toBe("Acme Bot");

    expect(canManageTeamDisplayName("owner")).toBe(true);
    expect(canManageTeamDisplayName("admin")).toBe(true);
    expect(canManageTeamDisplayName("modo")).toBe(false);
    expect(canManageTeamDisplayName("regular")).toBe(false);

    const envId = EnvironmentId.make("env-1");
    const teamId = TeamId.make("team-1");
    expect(resolveScheduledTaskScope(null, envId)).toEqual({
      kind: "personal",
      teamId: null,
      environmentId: envId,
    });
    expect(resolveScheduledTaskScope(teamId, envId)).toEqual({
      kind: "team",
      teamId,
      environmentId: envId,
    });
  });

  it("enforces scheduled-task RBAC and anti-escalation across owner, admin, modo, and regular", () => {
    expect(canManageTeamScheduledTasks("owner")).toBe(true);
    expect(canManageTeamScheduledTasks("admin")).toBe(true);
    expect(canManageTeamScheduledTasks("modo")).toBe(true);
    expect(canManageTeamScheduledTasks("regular")).toBe(false);

    expect(canManagePrivilegedTeamScheduledTasks("owner")).toBe(true);
    expect(canManagePrivilegedTeamScheduledTasks("admin")).toBe(true);
    expect(canManagePrivilegedTeamScheduledTasks("modo")).toBe(false);
    expect(canManagePrivilegedTeamScheduledTasks("regular")).toBe(false);

    // Read requires access to BOTH environment and view.
    expect(
      canMemberReadTeamScheduledTask({ member: regular, environment: openEnv, view: openView }),
    ).toBe(true);
    expect(
      canMemberReadTeamScheduledTask({ member: regular, environment: adminEnv, view: openView }),
    ).toBe(false);
    expect(
      canMemberReadTeamScheduledTask({ member: regular, environment: openEnv, view: adminView }),
    ).toBe(false);

    // Modo can mutate minimal unlocked tasks in accessible scope, but NOT elevated/locked ones.
    expect(
      canMemberMutateTeamScheduledTask({
        member: modo,
        environment: openEnv,
        view: openView,
        existingMeta: { locked: false, mcpAccessLevel: "minimal" },
      }),
    ).toBe(true);
    expect(
      canMemberMutateTeamScheduledTask({
        member: modo,
        environment: openEnv,
        view: openView,
        nextLocked: true,
      }),
    ).toBe(false);
    expect(
      canMemberMutateTeamScheduledTask({
        member: modo,
        environment: openEnv,
        view: openView,
        nextMcpAccessLevel: "elevated",
      }),
    ).toBe(false);
    expect(
      canMemberMutateTeamScheduledTask({
        member: modo,
        environment: openEnv,
        view: openView,
        existingMeta: { locked: true, mcpAccessLevel: "minimal" },
      }),
    ).toBe(false);
    expect(
      canMemberMutateTeamScheduledTask({
        member: modo,
        environment: openEnv,
        view: openView,
        existingMeta: { locked: false, mcpAccessLevel: "elevated" },
      }),
    ).toBe(false);
    expect(
      canMemberMutateTeamScheduledTask({
        member: admin,
        environment: openEnv,
        view: openView,
        existingMeta: { locked: true, mcpAccessLevel: "elevated" },
      }),
    ).toBe(true);

    // Webhook visibility mirrors mutation authority (redacted for regular and for modo on locked/elevated).
    expect(
      canMemberSeeTeamScheduledTaskWebhook({
        member: regular,
        environment: openEnv,
        view: openView,
        meta: { locked: false, mcpAccessLevel: "minimal" },
      }),
    ).toBe(false);
    expect(
      canMemberSeeTeamScheduledTaskWebhook({
        member: modo,
        environment: openEnv,
        view: openView,
        meta: { locked: false, mcpAccessLevel: "minimal" },
      }),
    ).toBe(true);
    expect(
      canMemberSeeTeamScheduledTaskWebhook({
        member: modo,
        environment: openEnv,
        view: openView,
        meta: { locked: false, mcpAccessLevel: "elevated" },
      }),
    ).toBe(false);
    expect(
      canMemberSeeTeamScheduledTaskWebhook({
        member: owner,
        environment: openEnv,
        view: openView,
        meta: { locked: true, mcpAccessLevel: "elevated" },
      }),
    ).toBe(true);
  });

  it("enforces posting, queueing, steering, interrupt, and notification rules on team-owned threads", () => {
    const unlockedTeamThread = {
      ownerKind: "team" as const,
      creatorMemberId: null,
      locked: false,
    };
    const lockedTeamThread = {
      ownerKind: "team" as const,
      creatorMemberId: null,
      locked: true,
    };

    // Posting on unlocked team-owned thread: modo always allowed when view is readable, regular follows postRule.
    expect(
      resolveTeamThreadPostBlockReason({
        member: modo,
        attribution: unlockedTeamThread,
        view: readOnlyView,
      }),
    ).toBe("ok");
    expect(
      resolveTeamThreadPostBlockReason({
        member: regular,
        attribution: unlockedTeamThread,
        view: readOnlyView,
      }),
    ).toBe("view_read_only");
    expect(
      resolveTeamThreadPostBlockReason({
        member: regular,
        attribution: unlockedTeamThread,
        view: openView,
      }),
    ).toBe("ok");
    // Locked team-owned thread: owner/admin only.
    expect(
      resolveTeamThreadPostBlockReason({
        member: modo,
        attribution: lockedTeamThread,
        view: openView,
      }),
    ).toBe("locked");
    expect(
      resolveTeamThreadPostBlockReason({
        member: admin,
        attribution: lockedTeamThread,
        view: openView,
      }),
    ).toBe("ok");

    // No member (not even owner) may steer or Send now on a team-owned thread or during an active team_automation turn.
    expect(
      canMemberSteerActiveTeamTurn({
        member: owner,
        attribution: unlockedTeamThread,
        view: openView,
      }),
    ).toBe(false);
    expect(
      canMemberPromoteTeamQueuedRun({
        member: modo,
        attribution: unlockedTeamThread,
        view: openView,
      }),
    ).toBe(false);
    const aliceMemberThread = {
      ownerKind: "member" as const,
      creatorMemberId: owner.id,
      locked: false,
    };
    expect(
      canMemberSteerActiveTeamTurn({
        member: owner,
        attribution: aliceMemberThread,
        view: openView,
        activeTurnAuthorKind: "team_automation",
      }),
    ).toBe(false);
    expect(
      canMemberPromoteTeamQueuedRun({
        member: owner,
        attribution: aliceMemberThread,
        view: openView,
        activeTurnAuthorKind: "team_automation",
      }),
    ).toBe(false);

    // Interrupt: owner/admin always allowed; modo allowed on unlocked readable automation runs (not locked); regular cannot.
    expect(
      canMemberInterruptTeamTurn({
        member: owner,
        attribution: unlockedTeamThread,
        view: openView,
        activeTurnAuthorMemberId: null,
      }),
    ).toBe(true);
    expect(
      canMemberInterruptTeamTurn({
        member: admin,
        attribution: unlockedTeamThread,
        view: openView,
        activeTurnAuthorMemberId: null,
      }),
    ).toBe(true);
    expect(
      canMemberInterruptTeamTurn({
        member: modo,
        attribution: unlockedTeamThread,
        view: openView,
        activeTurnAuthorMemberId: null,
      }),
    ).toBe(true);
    expect(
      canMemberInterruptTeamTurn({
        member: modo,
        attribution: lockedTeamThread,
        view: openView,
        activeTurnAuthorMemberId: null,
      }),
    ).toBe(false);
    expect(
      canMemberInterruptTeamTurn({
        member: regular,
        attribution: unlockedTeamThread,
        view: openView,
        activeTurnAuthorMemberId: null,
      }),
    ).toBe(false);
    // Human author of a follow-up turn in a team-owned thread can interrupt their own turn.
    expect(
      canMemberInterruptTeamTurn({
        member: regular,
        attribution: unlockedTeamThread,
        view: openView,
        activeTurnAuthorMemberId: regular.id,
      }),
    ).toBe(true);

    // Queued-message notification recipients: creator + distinct human active turn author, never sender.
    expect(
      resolveTeamQueuedMessageNotificationRecipients({
        senderMemberId: modo.id,
        attribution: aliceMemberThread,
        activeTurnAuthorMemberId: owner.id,
      }),
    ).toEqual([owner.id]);
    expect(
      resolveTeamQueuedMessageNotificationRecipients({
        senderMemberId: modo.id,
        attribution: aliceMemberThread,
        activeTurnAuthorMemberId: regular.id,
      }),
    ).toEqual([owner.id, regular.id]);
    expect(
      resolveTeamQueuedMessageNotificationRecipients({
        senderMemberId: owner.id,
        attribution: aliceMemberThread,
        activeTurnAuthorMemberId: owner.id,
      }),
    ).toEqual([]);
    expect(
      resolveTeamQueuedMessageNotificationRecipients({
        senderMemberId: owner.id,
        attribution: aliceMemberThread,
        activeTurnAuthorMemberId: regular.id,
      }),
    ).toEqual([regular.id]);
    expect(
      resolveTeamQueuedMessageNotificationRecipients({
        senderMemberId: modo.id,
        attribution: unlockedTeamThread,
        activeTurnAuthorMemberId: null,
      }),
    ).toEqual([]);
    expect(
      resolveTeamQueuedMessageNotificationRecipients({
        senderMemberId: modo.id,
        attribution: unlockedTeamThread,
        activeTurnAuthorMemberId: regular.id,
      }),
    ).toEqual([regular.id]);

    // Notifications: zero default notifications for unfollowed team-owned threads; notifies when followed or own follow-up turn.
    expect(
      shouldNotifyTeamMemberForThread({
        hasTeam: true,
        memberId: owner.id,
        ownerKind: "team",
        creatorMemberId: null,
        isFollowing: false,
        activeTurnAuthorMemberId: null,
      }),
    ).toBe(false);
    expect(
      shouldNotifyTeamMemberForThread({
        hasTeam: true,
        memberId: modo.id,
        ownerKind: "team",
        creatorMemberId: null,
        isFollowing: true,
        activeTurnAuthorMemberId: null,
      }),
    ).toBe(true);
    expect(
      shouldNotifyTeamMemberForThread({
        hasTeam: true,
        memberId: modo.id,
        ownerKind: "team",
        creatorMemberId: null,
        isFollowing: false,
        activeTurnAuthorMemberId: modo.id,
      }),
    ).toBe(true);
  });
});
