import {
  EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectThreadRelationshipShells } from "./entities";

type Projection = Parameters<typeof selectThreadRelationshipShells>[1];

const shell = (id: string, parentThreadId: string | null = null) =>
  ({
    id,
    forkedFrom: null,
    lineage: { parentThreadId, relationshipToParent: parentThreadId === null ? null : "fork" },
  }) as unknown as OrchestrationV2ThreadShell;

const threadId = "current" as OrchestrationV2ThreadShell["id"];
const here = EnvironmentId.make("environment-here");
const launchedFrom = (id: string, launcher: string, environmentId = here) =>
  ({
    ...shell(id),
    delegatedFrom: { environmentId, threadId: launcher, title: launcher },
  }) as unknown as OrchestrationV2ThreadShell;

describe("selectThreadRelationshipShells", () => {
  it("keeps the thread, its parent, its children and the threads its projection names", () => {
    const threads = [
      shell("current", "parent"),
      shell("parent"),
      shell("child", "current"),
      shell("subagent-child"),
      shell("workflow-member"),
      shell("transfer-source"),
      shell("unrelated"),
      shell("grandchild", "child"),
    ];
    const projection = {
      thread: threads[0],
      subagents: [
        {
          childThreadId: "subagent-child",
          workflow: { agents: [{ childThreadId: "workflow-member" }, {}] },
        },
        { childThreadId: null },
      ],
      contextTransfers: [{ sourceThreadId: "transfer-source", targetThreadId: "current" }],
    } as unknown as Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "subagents" | "contextTransfers"
    >;

    expect(
      selectThreadRelationshipShells(threadId, projection, threads, here).map(
        (thread) => thread.id,
      ),
    ).toEqual([
      "current",
      "parent",
      "child",
      "subagent-child",
      "workflow-member",
      "transfer-source",
    ]);
  });

  it("finds the parent from the shell before the projection loads", () => {
    const threads = [shell("current", "parent"), shell("parent"), shell("unrelated")];
    expect(
      selectThreadRelationshipShells(threadId, null as Projection, threads, here).map(
        (thread) => thread.id,
      ),
    ).toEqual(["current", "parent"]);
  });

  it("keeps the threads it launched here and the thread that launched it", () => {
    const threads = [
      launchedFrom("current", "launcher"),
      shell("launcher"),
      launchedFrom("worker", "current"),
      // A linked environment's task names its parent there by an id this one could share.
      launchedFrom("linked-task", "current", EnvironmentId.make("environment-elsewhere")),
      shell("unrelated"),
    ];
    expect(
      selectThreadRelationshipShells(threadId, null as Projection, threads, here).map(
        (thread) => thread.id,
      ),
    ).toEqual(["current", "launcher", "worker"]);
  });
});
