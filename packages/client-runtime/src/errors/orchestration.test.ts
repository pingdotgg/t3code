import {
  CommandId,
  GitCommandError,
  OrchestrationDispatchCommandError,
  OrchestrationV2ThreadLaunchError,
  ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  vcsOperationErrorMessage,
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
} from "./orchestration.ts";

describe("wasBootstrapThreadDeleted", () => {
  it("accepts only a confirmed deleted bootstrap thread", () => {
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(true);
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({ message: "Failed to create worktree." }),
      ),
    ).toBe(false);
    expect(wasBootstrapThreadDeleted(new Error("connection lost"))).toBe(false);
  });
});

describe("wasBootstrapThreadNotCreated", () => {
  it("accepts only a confirmed never-created bootstrap thread", () => {
    const notCreated = new OrchestrationDispatchCommandError({
      message: "A separate worktree requires a base commit.",
      bootstrapThreadDisposition: "not-created",
    });
    expect(wasBootstrapThreadNotCreated(notCreated)).toBe(true);
    expect(wasBootstrapThreadDeleted(notCreated)).toBe(false);
    expect(
      wasBootstrapThreadNotCreated(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(false);
    expect(
      wasBootstrapThreadNotCreated(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
        }),
      ),
    ).toBe(false);
    expect(wasBootstrapThreadNotCreated(new Error("connection lost"))).toBe(false);
  });
});

describe("vcsOperationErrorMessage", () => {
  const detail =
    "T3 Code supports colocated Jujutsu repositories. Run `jj git colocation enable` in this repository, or open its Git checkout instead.";

  it("shows the unsupported Git reason after RPC JSON serialization", () => {
    const codec = Schema.toCodecJson(GitCommandError);
    const error = Schema.decodeSync(codec)(
      Schema.encodeSync(codec)(
        new GitCommandError({
          operation: "createWorktree",
          command: "jj",
          cwd: "/repo",
          reason: "unsupported_repository",
          detail,
        }),
      ),
    );
    expect(vcsOperationErrorMessage(error, "fallback")).toBe(detail);
  });

  it("shows the launch error's top-level message after RPC JSON serialization", () => {
    const codec = Schema.toCodecJson(OrchestrationV2ThreadLaunchError);
    const error = Schema.decodeSync(codec)(
      Schema.encodeSync(codec)(
        new OrchestrationV2ThreadLaunchError({
          commandId: CommandId.make("command"),
          projectId: ProjectId.make("project"),
          message: detail,
        }),
      ),
    );
    expect(vcsOperationErrorMessage(error, "fallback")).toBe(detail);
  });

  it("preserves ordinary Git command messages", () => {
    const codec = Schema.toCodecJson(GitCommandError);
    const error = Schema.decodeSync(codec)(
      Schema.encodeSync(codec)(
        new GitCommandError({
          operation: "createWorktree",
          command: "git worktree add",
          cwd: "/repo",
          reason: "path_already_exists",
          detail: "destination already exists",
        }),
      ),
    );
    expect(vcsOperationErrorMessage(error, "fallback")).toBe(
      "Git command failed in createWorktree (/repo): destination already exists (path_already_exists)",
    );
  });

  it("preserves ordinary errors without searching nested causes", () => {
    expect(
      vcsOperationErrorMessage(
        new Error("ordinary failure", {
          cause: { _tag: "VcsUnsupportedOperationError", detail },
        }),
        "fallback",
      ),
    ).toBe("ordinary failure");
    expect(vcsOperationErrorMessage({ detail }, "fallback")).toBe("fallback");
  });
});
