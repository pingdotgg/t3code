import { Schema } from "effect";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";

import { makeThreadShellFixture } from "../../test-fixtures";

export const NOW = "2026-06-02T00:00:00.000Z";

export const environmentId = EnvironmentId.make("environment-1");
export const decodeThreadShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);

export function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return makeThreadShellFixture({
    environmentId,
    ...input,
  });
}

export const BASE_MS = Date.parse(NOW);

export function makePendingTask(id: string): PendingNewTask {
  const creation = {
    projectId: ProjectId.make("project-1"),
    workspaceMode: "worktree" as const,
    branch: null,
    worktreePath: null,
  };
  return {
    kind: "pending",
    key: `pending-task:${id}`,
    environmentId,
    projectId: creation.projectId,
    projectTitle: undefined,
    projectCwd: undefined,
    branch: null,
    title: id,
    createdAt: NOW,
    message: {
      environmentId,
      threadId: ThreadId.make(`thread-${id}`),
      messageId: MessageId.make(id),
      commandId: CommandId.make(`command-${id}`),
      text: id,
      attachments: [],
      createdAt: NOW,
      creation,
    },
    creation,
  };
}
