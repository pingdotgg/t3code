import { expect, it } from "@effect/vitest";
import {
  CommandId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

import { userFacingShellSnapshot, withCreationProvenance } from "./ThreadManagementService.ts";

it("stamps authoritative provenance on commands that create threads or messages", () => {
  const command: OrchestrationV2Command = {
    type: "thread.create",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: CommandId.make("command:thread-management:create"),
    threadId: ThreadId.make("thread:thread-management:create"),
    projectId: ProjectId.make("project:thread-management"),
    title: "Thread management",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  };

  expect(
    withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).toMatchObject({
    createdBy: "user",
    creationSource: "web",
  });
});

it("leaves commands that do not create durable authored content unchanged", () => {
  const command: OrchestrationV2Command = {
    type: "run.interrupt",
    commandId: CommandId.make("command:thread-management:interrupt"),
    threadId: ThreadId.make("thread:thread-management:interrupt"),
    runId: RunId.make("run:thread-management:interrupt"),
  };

  expect(
    withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).toBe(command);
});

it("removes internal subagent children from active and archived shell collections", () => {
  const rootId = ThreadId.make("thread:thread-management:root");
  const forkId = ThreadId.make("thread:thread-management:fork");
  const lineageSubagentId = ThreadId.make("thread:thread-management:lineage-subagent");
  const nodeSubagentId = ThreadId.make("thread:thread-management:node-subagent");
  const shell = (
    id: ThreadId,
    lineage: OrchestrationV2ThreadShell["lineage"],
    forkedFrom: OrchestrationV2ThreadShell["forkedFrom"],
  ) =>
    ({
      id,
      lineage,
      forkedFrom,
    }) as OrchestrationV2ThreadShell;
  const rootLineage = {
    rootThreadId: rootId,
    parentThreadId: null,
    relationshipToParent: null,
  } as const;
  const snapshot = userFacingShellSnapshot({
    schemaVersion: 3,
    snapshotSequence: 10,
    threads: [
      shell(rootId, rootLineage, null),
      shell(
        forkId,
        {
          rootThreadId: rootId,
          parentThreadId: rootId,
          relationshipToParent: "fork",
        },
        { type: "run", threadId: rootId, runId: RunId.make("run:thread-management:fork") },
      ),
      shell(
        lineageSubagentId,
        {
          rootThreadId: rootId,
          parentThreadId: rootId,
          relationshipToParent: "subagent",
        },
        null,
      ),
    ],
    archivedThreads: [
      shell(nodeSubagentId, rootLineage, {
        type: "node",
        nodeId: NodeId.make("node:thread-management:subagent"),
      }),
    ],
  });

  expect(snapshot.threads.map((thread) => thread.id)).toEqual([rootId, forkId]);
  expect(snapshot.archivedThreads).toEqual([]);
});
