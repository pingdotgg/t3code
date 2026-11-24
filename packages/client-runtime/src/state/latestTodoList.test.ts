import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  PlanId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2PlanStep,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { selectLatestTodoList, selectThreadTodoLists } from "./latestTodoList.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "./threadState.ts";

type Status = OrchestrationV2PlanStep["status"];

function run(ordinal: number, threadId: ThreadId = v2ThreadId): OrchestrationV2Run {
  return {
    id: RunId.make(`run-${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: v2Now,
    startedAt: v2Now,
    completedAt: v2Now,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function steps(...statuses: ReadonlyArray<Status>): Array<OrchestrationV2PlanStep> {
  return statuses.map((status, index) => ({
    id: `step-${index}`,
    text: `Step ${index}`,
    status,
  }));
}

function todo(
  id: string,
  runOrdinal: number | null,
  stepStatuses: ReadonlyArray<Status>,
  status: OrchestrationV2PlanArtifact["status"] = stepStatuses.every((s) => s === "completed")
    ? "completed"
    : "active",
  threadId: ThreadId = v2ThreadId,
): OrchestrationV2PlanArtifact {
  return {
    id: PlanId.make(id),
    threadId,
    runId: runOrdinal === null ? null : RunId.make(`run-${runOrdinal}`),
    nodeId: NodeId.make("node"),
    status,
    kind: "todo_list",
    steps: steps(...stepStatuses),
  };
}

function todoItem(
  plan: OrchestrationV2PlanArtifact & { kind: "todo_list" },
  ordinal: number,
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(`item-${plan.id}`),
    threadId: plan.threadId,
    runId: plan.runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    // The adapter always marks the todo list item completed, even mid-run.
    status: "completed",
    title: "Todo list",
    startedAt: v2Now,
    completedAt: v2Now,
    updatedAt: v2Now,
    type: "todo_list",
    planId: plan.id,
    steps: plan.steps,
  };
}

function projection(
  parts: Partial<Pick<OrchestrationV2ThreadProjection, "plans" | "runs" | "turnItems">>,
  threadId: ThreadId = v2ThreadId,
): OrchestrationV2ThreadProjection {
  return {
    ...v2Projection,
    thread: { ...v2Projection.thread, id: threadId },
    plans: [],
    runs: [],
    turnItems: [],
    ...parts,
  };
}

function planUpdated(plan: OrchestrationV2PlanArtifact) {
  return {
    id: EventId.make(`plan-${plan.id}-${plan.status}-${JSON.stringify(plan)}`),
    type: "plan.updated" as const,
    threadId: plan.threadId,
    occurredAt: v2Now,
    payload: plan,
  };
}

const asTodo = (plan: OrchestrationV2PlanArtifact) =>
  plan as OrchestrationV2PlanArtifact & { kind: "todo_list" };

describe("selectLatestTodoList", () => {
  it("returns null without a todo list", () => {
    expect(selectLatestTodoList(null)).toBeNull();
    expect(selectLatestTodoList(projection({ runs: [run(1)] }))).toBeNull();
    const proposed: OrchestrationV2PlanArtifact = {
      id: PlanId.make("plan-proposed"),
      threadId: v2ThreadId,
      runId: RunId.make("run-1"),
      nodeId: NodeId.make("node"),
      status: "active",
      kind: "proposed_plan",
      markdown: "# Plan",
    };
    expect(selectLatestTodoList(projection({ runs: [run(1)], plans: [proposed] }))).toBeNull();
  });

  it("returns a fresh list with every step pending, in order", () => {
    const plan = todo("plan-a", 1, ["pending", "pending", "pending"]);
    const result = selectLatestTodoList(projection({ runs: [run(1)], plans: [plan] }));
    expect(result).toBe(plan);
    expect(result?.steps.map((step) => step.id)).toEqual(["step-0", "step-1", "step-2"]);
  });

  it("keeps the planning list until the next run publishes its own", () => {
    const planning = todo("plan-a", 1, ["pending", "pending"]);
    // /go started a new run that has not called todowrite yet.
    const waiting = projection({ runs: [run(1), run(2)], plans: [planning] });
    expect(selectLatestTodoList(waiting)).toBe(planning);

    const executing = todo("plan-b", 2, ["running", "pending"]);
    const next = applyOrchestrationV2ProjectionEvent(waiting, planUpdated(executing));
    expect(selectLatestTodoList(next)?.id).toBe(executing.id);
  });

  it("prefers a newer completed list over an older one still marked active", () => {
    const older = todo("plan-z", 1, ["running", "pending"], "active");
    const newer = todo("plan-a", 2, ["completed", "completed"], "completed");
    expect(
      selectLatestTodoList(projection({ runs: [run(1), run(2)], plans: [older, newer] })),
    ).toBe(newer);
    expect(
      selectLatestTodoList(projection({ runs: [run(2), run(1)], plans: [newer, older] })),
    ).toBe(newer);
  });

  it("updates one list in place across todowrite calls", () => {
    let current: OrchestrationV2ThreadProjection | null = projection({ runs: [run(1)] });
    for (const statuses of [
      ["running", "pending"],
      ["completed", "running"],
      ["completed", "completed"],
    ] as const) {
      current = applyOrchestrationV2ProjectionEvent(
        current,
        planUpdated(todo("plan-a", 1, statuses)),
      );
    }
    expect(current?.plans).toHaveLength(1);
    const result = selectLatestTodoList(current);
    expect(result?.steps.map((step) => [step.id, step.status])).toEqual([
      ["step-0", "completed"],
      ["step-1", "completed"],
    ]);
  });

  it("reads step statuses, not the todo list item's status", () => {
    const plan = asTodo(todo("plan-a", 1, ["completed", "running"]));
    const result = selectLatestTodoList(
      projection({ runs: [run(1)], plans: [plan], turnItems: [todoItem(plan, 3)] }),
    );
    expect(result?.steps.map((step) => step.status)).toEqual(["completed", "running"]);
  });

  it("picks the same list live and from a hydrated snapshot", () => {
    const a = todo("plan-a", 1, ["running"]);
    const b = todo("plan-b", 2, ["completed"]);
    let live: OrchestrationV2ThreadProjection | null = projection({ runs: [run(1), run(2)] });
    live = applyOrchestrationV2ProjectionEvent(live, planUpdated(a));
    live = applyOrchestrationV2ProjectionEvent(live, planUpdated(b));
    const hydrated = projection({ runs: [run(2), run(1)], plans: [b, a] });
    expect(selectLatestTodoList(live)?.id).toBe(b.id);
    expect(selectLatestTodoList(hydrated)?.id).toBe(b.id);
  });

  it("breaks a same-run tie by turn item ordinal, then by plan id", () => {
    const first = asTodo(todo("plan-b", 1, ["completed"]));
    const second = asTodo(todo("plan-a", 1, ["pending"]));
    expect(
      selectLatestTodoList(
        projection({
          runs: [run(1)],
          plans: [first, second],
          turnItems: [todoItem(first, 2), todoItem(second, 5)],
        }),
      ),
    ).toBe(second);
    expect(selectLatestTodoList(projection({ runs: [run(1)], plans: [second, first] }))).toBe(
      first,
    );
  });

  it("ignores superseded, unscoped and emptied lists", () => {
    const kept = todo("plan-a", 1, ["completed"]);
    expect(
      selectLatestTodoList(
        projection({
          runs: [run(1), run(2)],
          plans: [
            kept,
            todo("plan-b", 2, ["pending"], "superseded"),
            todo("plan-c", null, ["pending"]),
            todo("plan-d", 9, ["pending"]),
          ],
        }),
      ),
    ).toBe(kept);
    expect(
      selectLatestTodoList(
        projection({ runs: [run(1), run(2)], plans: [kept, todo("plan-e", 2, [])] }),
      ),
    ).toBeNull();
  });
});

describe("latestTodoListAtom", () => {
  const environmentId = EnvironmentId.make("environment-1");
  const threadX = ThreadId.make("thread-x");
  const threadY = ThreadId.make("thread-y");

  it("keeps each thread's list apart and holds identity through unrelated updates", () => {
    const xPlan = todo("plan-x", 1, ["running", "pending"], "active", threadX);
    let x = projection({ runs: [run(1, threadX)], plans: [xPlan] }, threadX);
    const y = projection({ runs: [run(1, threadY)] }, threadY);
    const states = new Map([
      [
        threadX,
        Atom.make(AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(x) })),
      ],
      [
        threadY,
        Atom.make(AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(y) })),
      ],
    ]);
    const details = createEnvironmentThreadDetailAtoms((_, threadId) => states.get(threadId)!);
    const xAtom = details.latestTodoListAtom({ environmentId, threadId: threadX });
    const yAtom = details.latestTodoListAtom({ environmentId, threadId: threadY });
    const registry = AtomRegistry.make();
    registry.mount(xAtom);
    registry.mount(yAtom);

    expect(registry.get(xAtom)).toBe(xPlan);
    expect(registry.get(yAtom)).toBeNull();

    const message: OrchestrationV2ConversationMessage = {
      createdBy: "user",
      creationSource: "web",
      id: MessageId.make("message-x"),
      threadId: threadX,
      runId: RunId.make("run-1"),
      nodeId: null,
      role: "user",
      text: "hello",
      attachments: [],
      streaming: false,
      createdAt: v2Now,
      updatedAt: v2Now,
    };
    x = applyOrchestrationV2ProjectionEvent(x, {
      id: EventId.make("message-x"),
      type: "message.updated",
      threadId: threadX,
      occurredAt: v2Now,
      payload: message,
    })!;
    registry.set(
      states.get(threadX)!,
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(x) }),
    );
    expect(registry.get(xAtom)).toBe(xPlan);
    expect(registry.get(yAtom)).toBeNull();
    registry.dispose();
  });
});

function named(plan: OrchestrationV2PlanArtifact, prefix: string) {
  return asTodo({
    ...plan,
    steps: asTodo(plan).steps.map((step) => ({ ...step, text: `${prefix} ${step.text}` })),
  } as OrchestrationV2PlanArtifact);
}

describe("selectThreadTodoLists", () => {
  const texts = (lists: ReturnType<typeof selectThreadTodoLists>) =>
    lists.map((list) => list.steps.map((step) => `${step.text}:${step.status}`));

  it("keeps each earlier request's final list and puts the newest last", () => {
    const first = named(todo("p1", 1, ["completed", "completed"]), "A");
    const firstEarly = named(todo("p1", 1, ["completed", "running"]), "A");
    const second = named(todo("p2", 2, ["running", "pending"]), "B");
    const lists = selectThreadTodoLists(
      projection({
        runs: [run(1), run(2)],
        // The server snapshot only keeps the newest plan; earlier ones come from their items.
        plans: [second],
        turnItems: [todoItem(firstEarly, 1), todoItem(first, 2), todoItem(second, 3)],
      }),
    );
    expect(texts(lists)).toEqual([
      ["A Step 0:completed", "A Step 1:completed"],
      ["B Step 0:running", "B Step 1:pending"],
    ]);
  });

  it("lets a list that continues the previous one replace it", () => {
    // Written by /splan, never started, then run by /go in the next turn with new wording.
    const planned = named(todo("p1", 1, ["pending", "pending"]), "Long");
    const running = named(todo("p2", 2, ["completed", "running"]), "Short");
    expect(
      texts(
        selectThreadTodoLists(
          projection({
            runs: [run(1), run(2)],
            plans: [running],
            turnItems: [todoItem(planned, 1), todoItem(running, 2)],
          }),
        ),
      ),
    ).toEqual([["Short Step 0:completed", "Short Step 1:running"]]);

    // The same steps carried into a new turn, plus one more.
    const done = named(todo("p3", 1, ["completed", "running"]), "A");
    const extended = asTodo({
      ...named(todo("p4", 2, ["completed", "completed", "pending"]), "A"),
    });
    expect(
      selectThreadTodoLists(
        projection({
          runs: [run(1), run(2)],
          plans: [extended],
          turnItems: [todoItem(done, 1), todoItem(extended, 2)],
        }),
      ),
    ).toHaveLength(1);
  });

  it("skips superseded and empty lists and returns nothing without lists", () => {
    const gone = named(todo("p1", 1, ["completed"], "superseded"), "Gone");
    const empty = asTodo({ ...todo("p2", 2, []), steps: [] } as OrchestrationV2PlanArtifact);
    const last = named(todo("p3", 3, ["running"]), "C");
    expect(
      texts(
        selectThreadTodoLists(
          projection({
            runs: [run(1), run(2), run(3)],
            plans: [gone, last],
            turnItems: [todoItem(gone, 1), todoItem(empty, 2), todoItem(last, 3)],
          }),
        ),
      ),
    ).toEqual([["C Step 0:running"]]);
    expect(selectThreadTodoLists(projection({ runs: [run(1)] }))).toEqual([]);
    expect(selectThreadTodoLists(null)).toEqual([]);
  });
});
