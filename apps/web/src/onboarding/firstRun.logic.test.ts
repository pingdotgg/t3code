import { describe, expect, it } from "vite-plus/test";

import {
  isFirstRunWorkspaceProvenanceAuthoritative,
  isFreshFirstRunWorkspace,
  resolveFirstRunDecision,
  resolveHostedFirstRunDecision,
  transitionFirstRunGateState,
} from "./firstRun.logic";

const freshWorkspace = {
  enabled: true,
  hydrated: true,
  completed: false,
  bootstrapped: true,
  authoritative: true,
  workspaceAuthoritative: true,
  workspaceProvenanceAuthoritative: true,
  catalogReady: true,
  serverConfigAvailable: true,
  workspaceFresh: true,
  projectCount: 1,
  threadCount: 1,
} as const;

describe("resolveFirstRunDecision", () => {
  it("opens the wizard for an authoritative fresh workspace", () => {
    expect(resolveFirstRunDecision(freshWorkspace)).toEqual({
      decision: "wizard",
      persistCompletion: false,
    });
  });

  it("does not permanently complete onboarding from cached project counts", () => {
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        authoritative: false,
        projectCount: 3,
        workspaceFresh: false,
      }),
    ).toEqual({
      decision: "app",
      persistCompletion: false,
    });
  });

  it("backfills completion once existing projects are confirmed by the server", () => {
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        projectCount: 3,
        workspaceFresh: false,
      }),
    ).toEqual({
      decision: "app",
      persistCompletion: true,
    });
  });

  it("does not complete onboarding while another environment is still bootstrapping", () => {
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        bootstrapped: false,
        projectCount: 3,
        workspaceFresh: false,
      }),
    ).toEqual({
      decision: "app",
      persistCompletion: false,
    });
  });

  it("waits for managed environments before treating a workspace as new", () => {
    expect(resolveFirstRunDecision({ ...freshWorkspace, catalogReady: false })).toEqual({
      decision: "pending",
      persistCompletion: false,
    });
  });

  it("does not complete onboarding before the environment catalog is ready", () => {
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        catalogReady: false,
        projectCount: 3,
        workspaceFresh: false,
      }),
    ).toEqual({
      decision: "app",
      persistCompletion: false,
    });
  });

  it("does not complete onboarding before the server configuration is available", () => {
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        projectCount: 3,
        serverConfigAvailable: false,
        workspaceFresh: false,
      }),
    ).toEqual({
      decision: "app",
      persistCompletion: false,
    });
  });

  it("does not complete onboarding from cached remote projects", () => {
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        projectCount: 3,
        workspaceAuthoritative: false,
        workspaceFresh: false,
      }),
    ).toEqual({
      decision: "app",
      persistCompletion: false,
    });
  });

  it("does not complete onboarding from a single cached remote project", () => {
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        workspaceAuthoritative: false,
        workspaceFresh: false,
      }),
    ).toEqual({
      decision: "app",
      persistCompletion: false,
    });
  });

  it("waits for live data before judging a single cached project", () => {
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        authoritative: false,
        workspaceFresh: false,
      }),
    ).toEqual({
      decision: "pending",
      persistCompletion: false,
    });
  });

  it("waits for the completed bootstrap welcome before judging a nonempty workspace", () => {
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        workspaceProvenanceAuthoritative: false,
      }),
    ).toEqual({
      decision: "pending",
      persistCompletion: false,
    });
  });

  it("waits when the initial welcome is pending and opens the wizard after completion", () => {
    const pendingProvenance = isFirstRunWorkspaceProvenanceAuthoritative({
      welcomeReceived: true,
      bootstrapStatus: "pending",
    });
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        workspaceProvenanceAuthoritative: pendingProvenance,
      }),
    ).toEqual({ decision: "pending", persistCompletion: false });

    const completedProvenance = isFirstRunWorkspaceProvenanceAuthoritative({
      welcomeReceived: true,
      bootstrapStatus: "complete",
    });
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        workspaceProvenanceAuthoritative: completedProvenance,
      }),
    ).toEqual({ decision: "wizard", persistCompletion: false });
  });

  it("does not wait for server data after onboarding is already complete", () => {
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        authoritative: false,
        bootstrapped: false,
        completed: true,
        serverConfigAvailable: false,
      }),
    ).toEqual({
      decision: "app",
      persistCompletion: false,
    });
  });
});

describe("isFirstRunWorkspaceProvenanceAuthoritative", () => {
  it("waits for cwd bootstrap when the initial catalog is empty", () => {
    expect(
      isFirstRunWorkspaceProvenanceAuthoritative({
        welcomeReceived: true,
        bootstrapStatus: "pending",
      }),
    ).toBe(false);
  });

  it("accepts an empty catalog after cwd bootstrap completes", () => {
    expect(
      isFirstRunWorkspaceProvenanceAuthoritative({
        welcomeReceived: true,
        bootstrapStatus: "complete",
      }),
    ).toBe(true);
  });

  it("waits for a welcome before treating an empty catalog as final", () => {
    expect(
      isFirstRunWorkspaceProvenanceAuthoritative({
        welcomeReceived: false,
        bootstrapStatus: null,
      }),
    ).toBe(false);
  });

  it("accepts a legacy welcome without bootstrap status", () => {
    expect(
      isFirstRunWorkspaceProvenanceAuthoritative({
        welcomeReceived: true,
        bootstrapStatus: null,
      }),
    ).toBe(true);
  });
});

describe("transitionFirstRunGateState", () => {
  it("shows recovery without mounting the app when evidence stalls", () => {
    expect(
      transitionFirstRunGateState({ decision: "pending", stalled: false }, { type: "timeout" }),
    ).toEqual({ decision: "pending", stalled: true });
  });

  it.each(["app", "wizard"] as const)(
    "resolves stalled recovery to %s only after authoritative evidence",
    (decision) => {
      expect(
        transitionFirstRunGateState(
          { decision: "pending", stalled: true },
          { type: "evidence", decision },
        ),
      ).toEqual({ decision, stalled: false });
    },
  );

  it("keeps recovery visible while evidence remains pending", () => {
    const state = { decision: "pending", stalled: true } as const;
    expect(transitionFirstRunGateState(state, { type: "evidence", decision: "pending" })).toBe(
      state,
    );
  });

  it("allows authoritative wizard evidence to replace an app decision", () => {
    expect(
      transitionFirstRunGateState(
        { decision: "app", stalled: false },
        { type: "evidence", decision: "wizard" },
      ),
    ).toEqual({ decision: "wizard", stalled: false });
  });
});

describe("resolveHostedFirstRunDecision", () => {
  it("keeps the shell hidden until client settings are hydrated", () => {
    expect(
      resolveHostedFirstRunDecision({
        hydrated: false,
        completed: false,
        catalogReady: true,
        environmentCount: 0,
      }),
    ).toEqual({
      decision: "pending",
      persistCompletion: false,
    });
  });

  it("waits for the saved environment catalog before judging a hosted install", () => {
    expect(
      resolveHostedFirstRunDecision({
        hydrated: true,
        completed: false,
        catalogReady: false,
        environmentCount: 0,
      }),
    ).toEqual({
      decision: "pending",
      persistCompletion: false,
    });
  });

  it("opens onboarding when a hosted install has no saved environments", () => {
    expect(
      resolveHostedFirstRunDecision({
        hydrated: true,
        completed: false,
        catalogReady: true,
        environmentCount: 0,
      }),
    ).toEqual({
      decision: "wizard",
      persistCompletion: false,
    });
  });

  it("backfills onboarding for a hosted install with saved environments", () => {
    expect(
      resolveHostedFirstRunDecision({
        hydrated: true,
        completed: false,
        catalogReady: true,
        environmentCount: 1,
      }),
    ).toEqual({
      decision: "app",
      persistCompletion: true,
    });
  });

  it("opens the app immediately after hosted onboarding is complete", () => {
    expect(
      resolveHostedFirstRunDecision({
        hydrated: true,
        completed: true,
        catalogReady: false,
        environmentCount: 0,
      }),
    ).toEqual({
      decision: "app",
      persistCompletion: false,
    });
  });
});

const primaryEnvironmentId = "primary-environment";
const bootstrapProject = {
  id: "bootstrap-project",
  environmentId: primaryEnvironmentId,
  workspaceRoot: "/projects/current",
};
const bootstrapThread = {
  id: "bootstrap-thread",
  projectId: bootstrapProject.id,
  environmentId: primaryEnvironmentId,
  latestTurn: null,
  latestUserMessageAt: null,
  session: null,
};

describe("isFreshFirstRunWorkspace", () => {
  it("accepts an empty workspace", () => {
    expect(
      isFreshFirstRunWorkspace({
        primaryEnvironmentId,
        serverCwd: "/projects/current",
        projects: [],
        threads: [],
      }),
    ).toBe(true);
  });

  it("accepts only the unused project and thread created from the server cwd", () => {
    expect(
      isFreshFirstRunWorkspace({
        primaryEnvironmentId,
        serverCwd: "/projects/current/",
        bootstrapProjectId: bootstrapProject.id,
        bootstrapThreadId: bootstrapThread.id,
        bootstrapProjectCreated: true,
        bootstrapThreadCreated: true,
        projects: [bootstrapProject],
        threads: [bootstrapThread],
      }),
    ).toBe(true);
  });

  it("rejects an existing unused cwd project and thread reused by startup", () => {
    expect(
      isFreshFirstRunWorkspace({
        primaryEnvironmentId,
        serverCwd: "/projects/current",
        bootstrapProjectId: bootstrapProject.id,
        bootstrapThreadId: bootstrapThread.id,
        bootstrapProjectCreated: false,
        bootstrapThreadCreated: false,
        projects: [bootstrapProject],
        threads: [bootstrapThread],
      }),
    ).toBe(false);
  });

  it("rejects a nonempty workspace when an older server omits creation provenance", () => {
    expect(
      isFreshFirstRunWorkspace({
        primaryEnvironmentId,
        serverCwd: "/projects/current",
        bootstrapProjectId: bootstrapProject.id,
        bootstrapThreadId: bootstrapThread.id,
        projects: [bootstrapProject],
        threads: [bootstrapThread],
      }),
    ).toBe(false);
  });

  it("normalizes Windows project paths before checking the bootstrap workspace", () => {
    expect(
      isFreshFirstRunWorkspace({
        primaryEnvironmentId,
        serverCwd: "C:\\Projects\\Current\\",
        bootstrapProjectId: bootstrapProject.id,
        bootstrapThreadId: bootstrapThread.id,
        bootstrapProjectCreated: true,
        bootstrapThreadCreated: true,
        projects: [{ ...bootstrapProject, workspaceRoot: "c:/projects/current" }],
        threads: [bootstrapThread],
      }),
    ).toBe(true);
  });

  it("rejects projects from another environment even when their paths match", () => {
    expect(
      isFreshFirstRunWorkspace({
        primaryEnvironmentId,
        serverCwd: "/projects/current",
        projects: [{ ...bootstrapProject, environmentId: "remote-environment" }],
        threads: [],
      }),
    ).toBe(false);
  });

  it("rejects threads from another environment", () => {
    expect(
      isFreshFirstRunWorkspace({
        primaryEnvironmentId,
        serverCwd: "/projects/current",
        projects: [bootstrapProject],
        threads: [{ ...bootstrapThread, environmentId: "remote-environment" }],
      }),
    ).toBe(false);
  });

  it("rejects a thread that does not belong to the bootstrap project", () => {
    expect(
      isFreshFirstRunWorkspace({
        primaryEnvironmentId,
        serverCwd: "/projects/current",
        projects: [bootstrapProject],
        threads: [{ ...bootstrapThread, projectId: "another-project" }],
      }),
    ).toBe(false);
  });

  it("rejects a thread when there is no bootstrap project", () => {
    expect(
      isFreshFirstRunWorkspace({
        primaryEnvironmentId,
        serverCwd: "/projects/current",
        projects: [],
        threads: [bootstrapThread],
      }),
    ).toBe(false);
  });

  it("rejects a bootstrap thread that already has a user message", () => {
    expect(
      isFreshFirstRunWorkspace({
        primaryEnvironmentId,
        serverCwd: "/projects/current",
        projects: [bootstrapProject],
        threads: [
          {
            ...bootstrapThread,
            latestUserMessageAt: "2026-08-23T12:00:00.000Z",
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects a bootstrap thread that has started a turn", () => {
    expect(
      isFreshFirstRunWorkspace({
        primaryEnvironmentId,
        serverCwd: "/projects/current",
        projects: [bootstrapProject],
        threads: [{ ...bootstrapThread, latestTurn: { id: "first-turn" } }],
      }),
    ).toBe(false);
  });

  it("rejects a bootstrap thread that has a provider session", () => {
    expect(
      isFreshFirstRunWorkspace({
        primaryEnvironmentId,
        serverCwd: "/projects/current",
        projects: [bootstrapProject],
        threads: [{ ...bootstrapThread, session: { status: "ready" } }],
      }),
    ).toBe(false);
  });
});
