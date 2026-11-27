import {
  AuthFilesystemReadScope,
  AuthTerminalOperateScope,
  EnvironmentId,
  ProjectId,
  type AuthEnvironmentScope,
  type ManagedPolicySummary,
  type WorktreeLayoutCommand,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("environment:layout");
const projectId = ProjectId.make("project:layout");

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  commands: [] as WorktreeLayoutCommand[] | null,
  policy: undefined as ManagedPolicySummary | undefined,
  approveFails: false,
  approved: [] as unknown[],
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: (async (_registry: unknown, command: string, value: { input: unknown }) => {
    if (command === "read") {
      return state.commands === null
        ? { _tag: "Failure", cause: new Error("unavailable") }
        : { _tag: "Success", value: { commands: state.commands } };
    }
    state.approved.push(value.input);
    return state.approveFails
      ? { _tag: "Failure", cause: new Error("refused") }
      : { _tag: "Success", value: { commands: [] } };
  }) as never,
  squashAtomCommandFailure: ((result: { cause: unknown }) => result.cause) as never,
}));
vi.mock(
  import("./state/filesystem"),
  () =>
    ({
      filesystemEnvironment: { readLayoutCommands: "read", approveLayoutCommands: "approve" },
    }) as never,
);
vi.mock(
  import("./state/session"),
  () =>
    ({
      readEnvironmentScope: (_: EnvironmentId, scope: AuthEnvironmentScope) =>
        state.scopes.has(scope),
    }) as never,
);
vi.mock(
  import("./state/presentation"),
  () =>
    ({
      environmentPresentations: { serverConfigsAtom: "server-configs" },
    }) as never,
);
vi.mock(
  import("./rpc/atomRegistry"),
  () =>
    ({
      appAtomRegistry: { get: () => new Map([[environmentId, { managedPolicy: state.policy }]]) },
    }) as never,
);

import {
  ensureWorktreeLayoutApproved,
  readWorktreeLayoutApprovalState,
  respondToWorktreeLayoutApproval,
  subscribeWorktreeLayoutApprovalHost,
} from "./worktreeLayoutApproval";

const create: WorktreeLayoutCommand = {
  kind: "create",
  command: "./scripts/new-workspace.sh",
  approved: false,
};
const remove: WorktreeLayoutCommand = {
  kind: "remove",
  command: "./scripts/remove-workspace.sh",
  approved: false,
};
const ensure = () =>
  ensureWorktreeLayoutApproved({ environmentId, projectId, projectTitle: "Shop" });
const untilAsked = () =>
  vi.waitFor(() => expect(readWorktreeLayoutApprovalState().open).toBe(true));
/** Answers the request on screen, as the dialog's buttons do. */
const respond = (approved: boolean) =>
  respondToWorktreeLayoutApproval(readWorktreeLayoutApprovalState().request!.id, approved);

describe("worktree layout approval before a worktree thread starts", () => {
  beforeEach(() => {
    state.scopes = new Set([AuthFilesystemReadScope, AuthTerminalOperateScope]);
    state.commands = [create, remove];
    state.policy = undefined;
    state.approveFails = false;
    state.approved = [];
  });

  it("shows both unapproved commands and records the texts shown once the user approves", async () => {
    const unmount = subscribeWorktreeLayoutApprovalHost(() => {});
    const outcome = ensure();
    await untilAsked();
    expect(readWorktreeLayoutApprovalState().request).toMatchObject({
      projectTitle: "Shop",
      commands: [create, remove],
    });
    expect(state.approved).toEqual([]);

    respond(true);
    await expect(outcome).resolves.toEqual({ status: "proceed" });
    expect(state.approved).toEqual([
      {
        projectId,
        approvals: [
          { kind: "create", command: create.command },
          { kind: "remove", command: remove.command },
        ],
      },
    ]);
    unmount();
  });

  it("asks only about the command whose text is not approved", async () => {
    state.commands = [{ ...create, approved: true }, remove];
    const unmount = subscribeWorktreeLayoutApprovalHost(() => {});
    const outcome = ensure();
    await untilAsked();
    expect(readWorktreeLayoutApprovalState().request?.commands).toEqual([remove]);
    respond(true);
    await outcome;
    expect(state.approved).toEqual([
      { projectId, approvals: [{ kind: "remove", command: remove.command }] },
    ]);
    unmount();
  });

  it("records nothing and stops the send when the user cancels", async () => {
    const unmount = subscribeWorktreeLayoutApprovalHost(() => {});
    const outcome = ensure();
    await untilAsked();
    respond(false);
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expect(state.approved).toEqual([]);
    unmount();
  });

  it("drops an answer to a request that another one replaced", async () => {
    const unmount = subscribeWorktreeLayoutApprovalHost(() => {});
    const first = ensure();
    await untilAsked();
    const shown = readWorktreeLayoutApprovalState().request!;
    // The file changes and a second send asks while the first is still on screen.
    state.commands = [{ ...create, command: "./scripts/other.sh" }];
    const second = ensure();
    await expect(first).resolves.toEqual({ status: "cancelled" });
    await vi.waitFor(() => expect(readWorktreeLayoutApprovalState().request).not.toBe(shown));

    respondToWorktreeLayoutApproval(shown.id, true);
    expect(readWorktreeLayoutApprovalState().open).toBe(true);
    expect(state.approved).toEqual([]);

    respond(false);
    await expect(second).resolves.toEqual({ status: "cancelled" });
    expect(state.approved).toEqual([]);
    unmount();
  });

  it("records nothing when nothing is mounted to show the commands", async () => {
    await expect(ensure()).resolves.toEqual({ status: "cancelled" });
    expect(state.approved).toEqual([]);
  });

  it("does not ask when every command is approved, or the project declares none", async () => {
    state.commands = [{ ...create, approved: true }];
    await expect(ensure()).resolves.toEqual({ status: "proceed" });
    state.commands = [];
    await expect(ensure()).resolves.toEqual({ status: "proceed" });
    expect(readWorktreeLayoutApprovalState().open).toBe(false);
  });

  it("stops with a reason on a connection that cannot approve", async () => {
    state.scopes = new Set([AuthFilesystemReadScope]);
    const outcome = await ensure();
    expect(outcome.status).toBe("blocked");
    expect(state.approved).toEqual([]);
  });

  it("leaves the answer to the server when the commands cannot be read or policy turns them off", async () => {
    state.commands = null;
    await expect(ensure()).resolves.toEqual({ status: "proceed" });
    state.commands = [create];
    state.policy = {
      organization: "Example Corp",
      lockedSettings: [],
      limits: { worktreeLayoutCommands: false },
    };
    await expect(ensure()).resolves.toEqual({ status: "proceed" });
    state.scopes = new Set([AuthTerminalOperateScope]);
    state.policy = undefined;
    await expect(ensure()).resolves.toEqual({ status: "proceed" });
    expect(state.approved).toEqual([]);
  });

  it("stops with the server's reason when recording the approval fails", async () => {
    state.approveFails = true;
    const unmount = subscribeWorktreeLayoutApprovalHost(() => {});
    const outcome = ensure();
    await untilAsked();
    respond(true);
    await expect(outcome).resolves.toEqual({ status: "blocked", message: "refused" });
    unmount();
  });
});
