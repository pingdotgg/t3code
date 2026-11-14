import {
  newOrbitThreadStart,
  type OrbitGatewayBranchSelection,
  type OrbitGatewayOperation,
  type OrbitThreadStart,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it } from "vite-plus/test";

import { orbitReadyView, orbitSetupView } from "./orbitSetupView";

const fresh = newOrbitThreadStart({
  id: "s1",
  project: { id: 66, slug: "create-bench", nodeName: "beast" },
  message: "List the files",
  suffix: "x",
  threadId: "thread-1",
  messageId: "message-1",
  commandId: "command-1",
  now: 0,
  instanceName: "pricing-page",
  pendingThread: true,
});
const creating = {
  ...fresh,
  createStartedAt: 1_000,
  createKey: "k",
  createOperationId: 100,
  instanceId: 41,
};
const pairing = {
  ...creating,
  environmentId: "env-41",
  createFinishedAt: 9_000,
  connectStartedAt: 9_000,
};
const sent = {
  ...pairing,
  connected: true,
  connectFinishedAt: 11_000,
  agentStartedAt: 11_000,
  sentAt: 13_000,
};
const existing = {
  ...newOrbitThreadStart({
    id: "s2",
    project: { id: 66, slug: "create-bench", nodeName: "beast" },
    message: "List the files",
    suffix: "x",
    threadId: "thread-2",
    messageId: "message-2",
    commandId: "command-2",
    now: 0,
    existing: { instanceId: 7, environmentId: "env-7", name: "checkout", nodeName: "beast" },
  }),
};

const op = (progress: Partial<OrbitGatewayOperation>): OrbitGatewayOperation => ({
  id: 100,
  kind: "instance.create",
  status: "running",
  targetId: 41,
  errorCode: null,
  pollAfterSeconds: 2,
  ...progress,
});

/** Each card row as `label:status`, plus the Node and the create rows that left pending. */
function rows(start: OrbitThreadStart, create: OrbitGatewayOperation | null = null) {
  return orbitSetupView(start, create).stages.map((stage) =>
    [
      `${stage.label}:${stage.status}`,
      stage.detail,
      stage.rows
        ?.filter((row) => row.status !== "pending")
        .map((row) => `${row.label}:${row.status}`)
        .join(", "),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

describe("orbitSetupView", () => {
  it.each<[string, OrbitThreadStart, OrbitGatewayOperation | null, string[]]>([
    [
      "new, saved",
      fresh,
      null,
      ["Create Instance:pending beast", "Connect:pending", "Start agent:pending"],
    ],
    [
      "new, create running with saved rows",
      {
        ...creating,
        createRows: {
          container: { status: "done", startedAt: 1_000, finishedAt: 4_000 },
          address: { status: "running", startedAt: 1_200, finishedAt: null },
        },
      },
      null,
      [
        "Create Instance:running beast Copy the container:done, Publish the address:running",
        "Connect:pending",
        "Start agent:pending",
      ],
    ],
    [
      "new, connecting",
      pairing,
      null,
      ["Create Instance:done beast", "Connect:running", "Start agent:pending"],
    ],
    ["new, done", sent, null, ["Create Instance:done beast", "Connect:done", "Start agent:done"]],
    [
      "new, create failed",
      { ...creating, error: "Orbit could not create the clone.", errorCode: "instance.t3_unready" },
      op({ status: "failed", failedStep: "clone-t3" }),
      ["Create Instance:failed beast", "Connect:pending", "Start agent:pending"],
    ],
    ["existing, saved", existing, null, ["Connect:pending", "Start agent:pending"]],
    [
      "existing, done",
      { ...existing, connected: true, connectStartedAt: 1, sentAt: 2 },
      null,
      ["Connect:done", "Start agent:done"],
    ],
  ])("%s", (_name, start, create, expected) => {
    expect(rows(start, create)).toEqual(expected);
  });

  it("gives the running card its Details: what the start asked for", () => {
    expect(
      orbitSetupView({
        ...creating,
        branch: { mode: "new", from: "develop" },
        instanceDomainSuffix: ".create-bench.test",
      }).details,
    ).toEqual({
      instanceName: "pricing-page",
      nodeName: "beast",
      branch: "pricing-page",
      baseBranch: "develop",
      url: "https://pricing-page.create-bench.test",
    });
  });

  it("offers Change name only for a taken name, and says the Instance stays only when one was made", () => {
    const taken = {
      ...fresh,
      error: "The name is taken.",
      errorCode: "instance.name_taken",
      createStartedAt: 1,
    };
    expect(orbitSetupView(taken)).toMatchObject({
      phase: "failed",
      canChangeName: true,
      instanceStays: false,
    });
    const afterCreate = {
      ...pairing,
      error: "Orbit could not pair.",
      errorCode: "conn.unreachable",
    };
    expect(orbitSetupView(afterCreate)).toMatchObject({
      canChangeName: false,
      instanceStays: true,
    });
    const existingFailed = {
      ...existing,
      error: "Orbit could not pair.",
      errorCode: "instance.name_taken",
    };
    expect(orbitSetupView(existingFailed)).toMatchObject({
      canChangeName: false,
      instanceStays: false,
    });
  });
});

describe("orbitSetupView for branch refusals", () => {
  const newBranch = { mode: "new", from: "develop" } as const;
  const onBranch = { mode: "existing", name: "feature/login" } as const;
  /** Refused at admission: the HTTP answer to the create, so no Instance exists. */
  const refused = (
    branch: OrbitGatewayBranchSelection | null,
    errorCode: string,
    errorDetails: Record<string, unknown> = {},
  ): OrbitThreadStart => ({
    ...fresh,
    branch,
    defaultBranch: "main",
    createStartedAt: 1,
    error: "refused",
    errorCode,
    errorDetails,
  });
  /** Failed as a create step: the Operation's code, and the Instance stays. */
  const stepFailed = (errorCode: string): OrbitThreadStart => ({
    ...creating,
    branch: newBranch,
    defaultBranch: "main",
    createOperationId: null,
    error: `Orbit could not create the clone (${errorCode}).`,
    errorCode,
  });
  const card = (start: OrbitThreadStart) => {
    const view = orbitSetupView(start);
    return {
      error: view.error,
      changeName: view.canChangeName,
      changeBranch: view.canChangeBranch,
      open: view.openInstance?.name ?? null,
      stays: view.instanceStays,
      retry: view.canRetry,
    };
  };
  const quiet = {
    changeName: false,
    changeBranch: false,
    open: null,
    stays: false,
    retry: true,
  };

  it.each([
    [
      "in use, holder known",
      refused(onBranch, "branch.in_use", { instance: { id: 42, name: "login" } }),
      {
        ...quiet,
        error: "Instance login already works on feature/login.",
        changeBranch: true,
        open: "login",
      },
    ],
    [
      "in use, holder out of reach",
      refused(onBranch, "branch.in_use"),
      { ...quiet, error: "Another Instance already works on feature/login.", changeBranch: true },
    ],
    [
      "in use for a new branch named after the Instance",
      refused(newBranch, "branch.in_use"),
      { ...quiet, error: "Another Instance already works on pricing-page.", changeBranch: true },
    ],
    [
      "branch gone",
      refused(onBranch, "branch.not_found", { field: "branch.name" }),
      { ...quiet, error: "Branch feature/login no longer exists.", changeBranch: true },
    ],
    [
      "base gone",
      refused(newBranch, "branch.not_found", { field: "branch.from" }),
      { ...quiet, error: "Branch develop no longer exists.", changeBranch: true },
    ],
    [
      "new branch name exists",
      refused(newBranch, "branch.exists", { field: "name", branch: "fix-login" }),
      { ...quiet, error: "A branch named fix-login already exists.", changeName: true },
    ],
    [
      "name used with another branch",
      refused(newBranch, "instance.placement_conflict"),
      {
        ...quiet,
        error: "This name was already used with another branch. Choose another name.",
        changeName: true,
      },
    ],
    [
      "address too long",
      refused(null, "route.domain_invalid"),
      {
        ...quiet,
        error: "This name makes the address too long. Use a shorter name.",
        changeName: true,
      },
    ],
    [
      "repository unreadable",
      refused(newBranch, "source.head_unavailable"),
      { ...quiet, error: "Could not read the repository." },
    ],
    [
      "malformed branch object",
      refused(newBranch, "validation.failed"),
      { ...quiet, error: "refused" },
    ],
    [
      "clone step failed",
      stepFailed("instance.create_clone_failed"),
      {
        ...quiet,
        error: "Orbit could not create pricing-page: the clone operation failed on beast.",
        stays: true,
      },
    ],
    [
      "workspace step failed",
      stepFailed("instance.create_workspace_failed"),
      { ...quiet, error: "Orbit could not set up the workspace.", stays: true },
    ],
    [
      "a Project process did not start",
      {
        ...stepFailed("instance.container_process_inactive"),
        errorProcessUnit: "conn-web.service",
      },
      {
        ...quiet,
        error:
          "A process of this Project did not start: conn-web.service. Fix the Project, remove this Instance in Orbit, then create it again.",
        retry: false,
      },
    ],
    [
      "a Project process did not start, unit unknown",
      stepFailed("instance.container_process_inactive"),
      {
        ...quiet,
        error:
          "A process of this Project did not start. Fix the Project, remove this Instance in Orbit, then create it again.",
        retry: false,
      },
    ],
    [
      "a Project process did not start, Orbit retries with the current definitions",
      {
        ...stepFailed("instance.container_process_inactive"),
        errorProcessUnit: "conn-web.service",
        errorRecoveryRequires: "project_process_definition",
      },
      {
        ...quiet,
        error:
          "A process of this Project did not start: conn-web.service. Change or remove this process in the Project's Orbit settings, then retry.",
      },
    ],
    [
      "a Project process did not start, Orbit retries, unit unknown",
      {
        ...stepFailed("instance.container_process_inactive"),
        errorRecoveryRequires: "project_process_definition",
      },
      {
        ...quiet,
        error:
          "A process of this Project did not start. Change or remove this process in the Project's Orbit settings, then retry.",
      },
    ],
    [
      "a Project process did not start, Orbit names an unknown requirement",
      {
        ...stepFailed("instance.container_process_inactive"),
        errorProcessUnit: "conn-web.service",
        errorRecoveryRequires: "something_new",
      },
      {
        ...quiet,
        error:
          "A process of this Project did not start: conn-web.service. Fix the Project, remove this Instance in Orbit, then create it again.",
        retry: false,
      },
    ],
    [
      "create cancelled",
      stepFailed("operation.cancelled"),
      { ...quiet, error: "Orbit could not create the clone (operation.cancelled).", stays: true },
    ],
  ])("%s", (_name, start, expected) => {
    expect(card(start)).toEqual(expected);
  });

  it("shows Orbit's code and detail line under the text when the failed Operation sent one", () => {
    const failed = stepFailed("instance.create_clone_failed");
    expect(orbitSetupView(failed).errorDetailLine).toBeNull();
    const withDetail = { ...failed, errorDetail: " Argument list too long " };
    expect(orbitSetupView(withDetail).errorDetailLine).toBe(
      "instance.create_clone_failed · Argument list too long",
    );
    const pairing = { ...withDetail, errorCode: "conn.server_unreachable" };
    expect(orbitSetupView(pairing).errorDetailLine).toBe(
      "conn.server_unreachable · Argument list too long",
    );
    expect(orbitSetupView({ ...withDetail, error: null }).errorDetailLine).toBeNull();
  });

  it("offers no Change branch or Change name once the create made an Instance", () => {
    const made = { ...refused(onBranch, "branch.in_use"), instanceId: 41 };
    expect(card(made)).toMatchObject({ changeBranch: false, changeName: false, stays: true });
    const exists = { ...refused(newBranch, "branch.exists"), instanceId: 41 };
    expect(card(exists)).toMatchObject({ changeName: false, stays: true });
  });
});

describe("orbitReadyView", () => {
  it("builds Conn's ready line, with no setup time", () => {
    expect(orbitReadyView(sent, "https://pricing-page.nckrtl.test")).toEqual({
      instanceName: "pricing-page",
      nodeName: "beast",
      url: "https://pricing-page.nckrtl.test",
      readyLine:
        "Your Instance is ready. You can preview it at https://pricing-page.nckrtl.test while I work on your request.",
      modelFallbackLine: null,
      branch: null,
      baseBranch: null,
      dependenciesLine: null,
    });
    expect(orbitReadyView(sent, null).readyLine).toBe("Your Instance is ready.");
  });

  it("shows the result's branch and base, and the dependencies line only off the default branch", () => {
    const ready = (branch: OrbitGatewayBranchSelection | null, result: [string, string | null]) =>
      orbitReadyView(
        {
          ...sent,
          branch,
          defaultBranch: "main",
          resultBranch: result[0],
          resultBaseBranch: result[1],
        },
        null,
      );
    const line = "Dependencies and build come from the default branch.";
    expect(ready(null, ["pricing-page", "main"])).toMatchObject({
      branch: "pricing-page",
      baseBranch: "main",
      dependenciesLine: null,
    });
    expect(
      ready({ mode: "new", from: "main" }, ["pricing-page", "main"]).dependenciesLine,
    ).toBeNull();
    expect(ready({ mode: "new", from: "develop" }, ["pricing-page", "develop"])).toMatchObject({
      baseBranch: "develop",
      dependenciesLine: line,
    });
    // The result's base wins over the one asked for.
    expect(
      ready({ mode: "new", from: "develop" }, ["pricing-page", "main"]).dependenciesLine,
    ).toBeNull();
    expect(ready({ mode: "new", from: "main" }, ["pricing-page", "develop"]).dependenciesLine).toBe(
      line,
    );
    expect(
      ready({ mode: "existing", name: "feature/login" }, ["feature/login", null]),
    ).toMatchObject({ branch: "feature/login", baseBranch: null, dependenciesLine: line });
  });

  it("says when the agent uses the clone's default model", () => {
    const fallback = {
      ...sent,
      modelFallback: { requestedModel: "claude-opus-5-5", usedModel: "gpt-5.5" },
    };
    expect(orbitReadyView(fallback, null).modelFallbackLine).toBe(
      "This Instance does not offer claude-opus-5-5, so the agent uses gpt-5.5.",
    );
  });
});

describe("orbitSetupView with the create's completion (release 2030)", () => {
  const rows = {
    container: { status: "done" as const, startedAt: 1_000, finishedAt: 4_000 },
    address: { status: "running" as const, startedAt: 9_000, finishedAt: null },
    t3: { status: "done" as const, startedAt: 3_000, finishedAt: 6_000 },
    register: { status: "done" as const, startedAt: 6_000, finishedAt: 9_000 },
  };
  const following: OrbitThreadStart = {
    ...sent,
    completionOperationId: 106,
    completionStatus: "running",
    createRows: rows,
  };
  const rowStatuses = (start: OrbitThreadStart) =>
    orbitSetupView(start).stages[0]!.rows?.map((row) => `${row.id}:${row.status}`) ?? null;
  const failed = (extra: Partial<OrbitThreadStart>): OrbitThreadStart => ({
    ...following,
    completionStatus: "failed",
    completionRetryable: true,
    createRows: { ...rows, address: { ...rows.address, status: "failed", finishedAt: 14_000 } },
    ...extra,
  });

  it("storyboard 6: header and address spin, Connect and Start agent done, no Cancel", () => {
    const view = orbitSetupView(following);
    expect(view.phase).toBe("running");
    expect(view.stages.map((stage) => `${stage.id}:${stage.status}`)).toEqual([
      "create:running",
      "connect:done",
      "agent:done",
    ]);
    expect(rowStatuses(following)).toEqual([
      "container:done",
      "address:running",
      "t3:done",
      "register:done",
    ]);
    expect(view.stages[0]!.rows?.[1]?.detail).toBe(
      view.details.url?.replace("https://", "") ?? null,
    );
    expect(view.canCancel).toBe(false);
    expect(view.canRetry).toBe(false);
  });

  it("before the send, the pending card keeps Cancel while the completion runs (storyboard 4, 5)", () => {
    const connecting = {
      ...pairing,
      completionOperationId: 106,
      completionStatus: "queued" as const,
    };
    expect(orbitSetupView(connecting).canCancel).toBe(true);
    expect(orbitSetupView(connecting).stages[0]!.status).toBe("running");
    expect(orbitSetupView(pairing).canCancel).toBe(true);
    expect(orbitSetupView(creating).canCancel).toBe(true);
  });

  it("state 4: a succeeded completion is today's done card (the ready row)", () => {
    const view = orbitSetupView({ ...following, completionStatus: "succeeded" });
    expect(view.phase).toBe("done");
    expect(view.stages[0]!.rows).toBeNull();
  });

  it("state 5: the failed row, Conn's workspace message, the detail line, Retry and Dismiss", () => {
    const start = failed({
      completionErrorCode: "instance.create_workspace_failed",
      completionErrorDetail: "composer exit 1",
    });
    const view = orbitSetupView(start);
    expect(view).toMatchObject({
      phase: "failed",
      error: "Orbit could not set up the workspace.",
      errorDetailLine: "instance.create_workspace_failed · composer exit 1",
      canRetry: true,
      canChangeName: false,
      canChangeBranch: false,
      openInstance: null,
      instanceStays: true,
      canCancel: false,
    });
    expect(rowStatuses(start)).toEqual([
      "container:done",
      "address:failed",
      "t3:done",
      "register:done",
    ]);
    // failures.html 6: the header fails, Connect and Start agent stay done.
    expect(view.stages.map((stage) => stage.status)).toEqual(["failed", "done", "done"]);
  });

  it("Q2: a code without a Conn message shows only the detail line, or the code alone", () => {
    const route = orbitSetupView(
      failed({ completionErrorCode: "instance.create_route_failed", completionErrorDetail: "dns" }),
    );
    expect(route.error).toBeNull();
    expect(route.errorDetailLine).toBe("instance.create_route_failed · dns");
    const bare = orbitSetupView(failed({ completionErrorCode: "operation.admission_failed" }));
    expect(bare.error).toBeNull();
    expect(bare.errorDetailLine).toBe("operation.admission_failed");
  });

  it("Q7: a process that did not start says \u2026then retry while Orbit offers a Retry", () => {
    const view = orbitSetupView(
      failed({
        completionErrorCode: "instance.container_process_inactive",
        completionProcessUnit: "conn-web.service",
      }),
    );
    expect(view.error).toBe(
      "A process of this Project did not start: conn-web.service. Change or remove this process in the Project's Orbit settings, then retry.",
    );
    expect(view.canRetry).toBe(true);
  });

  it("state 12: a completion refused at admission fails the card at once", () => {
    const view = orbitSetupView(
      failed({ completionErrorCode: "instance.complete_unavailable", completionErrorDetail: null }),
    );
    expect(view.phase).toBe("failed");
    expect(view.canRetry).toBe(true);
  });

  it("state 6: Retry running shows the running card again, also before Orbit answered", () => {
    const view = orbitSetupView({ ...following, completionStatus: "queued" });
    expect(view.phase).toBe("running");
    expect(view.canCancel).toBe(false);
    const admitting = orbitSetupView({
      ...following,
      completionOperationId: null,
      completionKey: "k",
      completionStatus: "queued",
    });
    expect(admitting.phase).toBe("running");
    expect(admitting.canCancel).toBe(false);
    expect(admitting.stages[0]!.rows).not.toBeNull();
  });

  it("state 8: a removal's cancel shows nothing new", () => {
    const view = orbitSetupView({ ...following, completionStatus: "cancelled" });
    expect(view.phase).toBe("running");
    expect(view.error).toBeNull();
  });

  it("state 11: an older Gateway without a completion keeps today's done card", () => {
    const view = orbitSetupView(sent);
    expect(view.phase).toBe("done");
    expect(view.canCancel).toBe(false);
  });
});
