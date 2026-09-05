import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  start: vi.fn(),
  prepare: vi.fn(),
  reportError: vi.fn(),
  cleanup: vi.fn(),
  readScope: vi.fn(),
}));

vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("../../state/session", () => ({ readEnvironmentScope: state.readScope }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { startTurn: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.start }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  setPendingConnectionError: state.reportError,
}));
vi.mock("../../state/use-composer-drafts", () => ({
  scheduleUnusedComposerAttachmentCleanup: state.cleanup,
}));
vi.mock("../../lib/attachmentUpload", () => ({
  prepareTurnAttachments: state.prepare,
  validateDraftFileAttachments: () => null,
}));
vi.mock("../../lib/uuid", () => ({ randomHex: () => "abcdef", uuidv4: () => "unused" }));
vi.mock("../../lib/modelOptions", () => ({ isModelSelectionUnavailable: () => false }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: (environmentId: string) => environmentId },
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => ({ providers: [], environment: { capabilities: {} } }) },
}));

import { useCreateProjectThread } from "./use-project-actions";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");
const project: EnvironmentProject = {
  environmentId: secondary,
  id: ProjectId.make("project"),
  title: "Test project",
  workspaceRoot: "/work/project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-05T00:00:00Z",
  updatedAt: "2026-09-05T00:00:00Z",
};

function input() {
  return {
    project,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    envMode: "local" as const,
    branch: "main",
    worktreePath: null,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    initialMessageText: "Check the fixture",
    initialAttachments: [],
    onAttachmentsUploaded: vi.fn().mockResolvedValue(undefined),
    turnMetadata: {
      commandId: "command",
      threadId: "thread",
      messageId: "message",
      createdAt: "2026-09-05T00:00:00Z",
    },
  };
}

beforeEach(() => {
  state.allowed.clear();
  state.start.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.prepare.mockReset().mockResolvedValue({
    status: "ready",
    attachments: [],
    draftAttachments: [],
  });
  state.reportError.mockReset();
  state.cleanup.mockReset();
  state.readScope
    .mockReset()
    .mockImplementation(
      (environmentId, scope) =>
        scope === AuthOrchestrationOperateScope && state.allowed.has(environmentId),
    );
});

describe("new task permissions", () => {
  it("does not upload or start a task using another environment's grant", async () => {
    state.allowed.add(primary);
    const create = useCreateProjectThread();

    const result = await create(input());
    expect(result._tag).toBe("Failure");
    if (!AsyncResult.isFailure(result)) throw new Error("Expected permission denial");
    const error = Cause.squash<unknown>(result.cause);
    expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
    expect(error).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
    expect(state.reportError).toHaveBeenCalledWith("This connection cannot start tasks.");
  });

  it("allows the selected environment to start a task without a primary grant", async () => {
    state.allowed.add(secondary);
    const create = useCreateProjectThread();

    expect(await create(input())).toMatchObject({
      _tag: "Success",
      value: { environmentId: secondary, threadId: "thread" },
    });
    expect(state.start).toHaveBeenCalledExactlyOnceWith({
      environmentId: secondary,
      input: expect.objectContaining({ threadId: "thread" }),
    });
    expect(state.cleanup).toHaveBeenCalledTimes(1);
  });

  it("rechecks access after attachments finish preparing and preserves the draft", async () => {
    state.allowed.add(secondary);
    state.prepare.mockImplementationOnce(async () => {
      state.allowed.delete(secondary);
      return { status: "ready", attachments: [], draftAttachments: [] };
    });
    const create = useCreateProjectThread();

    const result = await create(input());
    expect(result._tag).toBe("Failure");
    if (!AsyncResult.isFailure(result)) throw new Error("Expected permission denial");
    const error = Cause.squash<unknown>(result.cause);
    expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
    expect(error).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
    expect(state.prepare).toHaveBeenCalledTimes(1);
    expect(state.start).not.toHaveBeenCalled();
    expect(state.cleanup).not.toHaveBeenCalled();
  });

  it("a retained start callback follows revoked and newly granted access", async () => {
    state.allowed.add(secondary);
    const create = useCreateProjectThread();
    state.allowed.delete(secondary);

    const result = await create(input());
    expect(result._tag).toBe("Failure");
    if (!AsyncResult.isFailure(result)) throw new Error("Expected permission denial");
    const error = Cause.squash<unknown>(result.cause);
    expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
    expect(error).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
    expect(state.prepare).not.toHaveBeenCalled();
    state.allowed.add(secondary);
    expect((await create(input()))._tag).toBe("Success");
    expect(state.start).toHaveBeenCalledTimes(1);
  });
});
